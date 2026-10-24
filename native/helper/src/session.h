#pragma once

// The only boundary between the helper's protocol/caching code and a switcher.
//
// A Session may ONLY: discover/connect, read state, and replace media-pool stills.
// It must never set keyers, media-player sources, program/preview, transitions
// or run macros. test/noControl.test.js scans native/ for forbidden SDK calls.

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "image.h"

namespace agl {

enum class Transport { Usb, Network };

struct PlayerInfo {
  int sourceType = 0;  // 1 = still, 2 = clip (matches atem-connection's MediaSourceType)
  int stillIndex = -1;
};

struct StillInfo {
  bool used = false;
  std::string name;
};

struct Snapshot {
  int width = 0;
  int height = 0;
  std::string productName;
  std::vector<PlayerInfo> players;
  std::vector<StillInfo> stills;
};

struct SessionEvents {
  std::function<void(const std::string& reason)> disconnected;
  std::function<void()> stateChanged;
};

class Session {
 public:
  virtual ~Session() = default;

  // "blackmagic", "mock" or "none"
  virtual std::string kind() const = 0;

  // False when the SDK runtime (Blackmagic ATEM Switchers software) is missing.
  virtual bool available(std::string& reason) = 0;

  // address is ignored for Transport::Usb (the SDK uses an empty address for USB-only).
  virtual bool connect(Transport transport, const std::string& address, std::string& err) = 0;
  virtual void disconnect() = 0;
  virtual bool connected() const = 0;

  virtual bool snapshot(Snapshot& out, std::string& err) = 0;

  // Pixel layout the SDK frame buffer wants, so images can be converted ahead of time.
  virtual PixelLayout frameLayout() const = 0;

  // Replace still `stillIndex` (0-based). Blocks until the switcher reports the
  // transfer finished or failed. Image is already in frameLayout() and the right size.
  virtual bool uploadStill(int stillIndex, const Image& image, const std::string& name, std::string& err) = 0;

  void setEvents(SessionEvents ev) { events_ = std::move(ev); }

 protected:
  SessionEvents events_;
};

std::unique_ptr<Session> createSession();

}  // namespace agl
