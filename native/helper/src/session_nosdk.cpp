// Built when the Blackmagic ATEM Switchers SDK headers are not available.
// The app then falls back to its Ethernet (atem-connection) backend.

#include "session.h"

namespace agl {

namespace {
class NoSdkSession final : public Session {
 public:
  std::string kind() const override { return "none"; }
  bool available(std::string& reason) override {
    reason = "this build does not include the Blackmagic ATEM Switchers SDK";
    return false;
  }
  bool connect(Transport, const std::string&, std::string& err) override {
    err = "Blackmagic SDK not included in this build";
    return false;
  }
  void disconnect() override {}
  bool connected() const override { return false; }
  bool snapshot(Snapshot&, std::string& err) override {
    err = "not connected";
    return false;
  }
  PixelLayout frameLayout() const override { return PixelLayout::RGBA; }
  bool uploadStill(int, const Image&, const std::string&, std::string& err) override {
    err = "Blackmagic SDK not included in this build";
    return false;
  }
};
}  // namespace

std::unique_ptr<Session> createSession() { return std::make_unique<NoSdkSession>(); }

}  // namespace agl
