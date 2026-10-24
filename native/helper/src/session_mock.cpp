// TEST BUILD ONLY (agl-helper-mock). Simulates a switcher so the helper protocol,
// caching and the app's fallback chain can be tested in CI without hardware.
// Never shipped in the app.
//
// Environment knobs:
//   AGL_MOCK_USB=0           USB connection fails
//   AGL_MOCK_NETWORK=0       network connection fails
//   AGL_MOCK_UNAVAILABLE=1   pretend the Blackmagic runtime is missing
//   AGL_MOCK_UPLOAD_MS=n     transfer time per upload (default 60)
//   AGL_MOCK_FAIL_UPLOADS=n  fail the first n uploads
//   AGL_MOCK_DROP_AFTER=n    drop the connection after n uploads
//   AGL_MOCK_CRASH_ON_UPLOAD=1  exit the process mid-upload

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <mutex>
#include <thread>

#include "session.h"

namespace agl {

namespace {

int envInt(const char* name, int def) {
  const char* v = std::getenv(name);
  return v ? std::atoi(v) : def;
}

class MockSession final : public Session {
 public:
  MockSession() {
    snap_.width = 1920;
    snap_.height = 1080;
    snap_.productName = "Mock ATEM Mini Extreme ISO";
    snap_.players = {{1, 0}, {1, 1}};
    snap_.stills.resize(20);
    failUploads_ = envInt("AGL_MOCK_FAIL_UPLOADS", 0);
  }

  std::string kind() const override { return "mock"; }

  bool available(std::string& reason) override {
    if (envInt("AGL_MOCK_UNAVAILABLE", 0)) {
      reason = "mock: Blackmagic ATEM Switchers software not installed";
      return false;
    }
    return true;
  }

  bool connect(Transport t, const std::string& address, std::string& err) override {
    if (t == Transport::Usb && envInt("AGL_MOCK_USB", 1) == 0) {
      err = "mock: no switcher on USB";
      return false;
    }
    if (t == Transport::Network && envInt("AGL_MOCK_NETWORK", 1) == 0) {
      err = "mock: no switcher at " + address;
      return false;
    }
    connected_ = true;
    return true;
  }

  void disconnect() override { connected_ = false; }
  bool connected() const override { return connected_; }

  bool snapshot(Snapshot& out, std::string& err) override {
    if (!connected_) {
      err = "not connected";
      return false;
    }
    std::lock_guard<std::mutex> l(m_);
    out = snap_;
    return true;
  }

  // Exercise a non-trivial conversion path in tests.
  PixelLayout frameLayout() const override { return PixelLayout::BGRA; }

  bool uploadStill(int stillIndex, const Image& image, const std::string& name, std::string& err) override {
    if (inUpload_.exchange(true)) {
      err = "mock: overlapping transfer (the helper must serialize uploads)";
      return false;
    }
    if (image.layout != frameLayout()) {
      inUpload_ = false;
      err = "mock: image not converted to frame layout";
      return false;
    }
    if (envInt("AGL_MOCK_CRASH_ON_UPLOAD", 0)) std::_Exit(3);
    std::this_thread::sleep_for(std::chrono::milliseconds(envInt("AGL_MOCK_UPLOAD_MS", 60)));
    inUpload_ = false;
    if (failUploads_ > 0) {
      --failUploads_;
      err = "mock: transfer failed";
      return false;
    }
    {
      std::lock_guard<std::mutex> l(m_);
      snap_.stills[stillIndex] = {true, name};
    }
    ++uploads_;
    if (events_.stateChanged) events_.stateChanged();
    const int dropAfter = envInt("AGL_MOCK_DROP_AFTER", 0);
    if (dropAfter && uploads_ >= dropAfter) {
      connected_ = false;
      if (events_.disconnected) events_.disconnected("mock: connection lost");
    }
    return true;
  }

 private:
  std::mutex m_;
  Snapshot snap_;
  std::atomic<bool> connected_{false};
  std::atomic<bool> inUpload_{false};
  int failUploads_ = 0;
  int uploads_ = 0;
};

}  // namespace

std::unique_ptr<Session> createSession() { return std::make_unique<MockSession>(); }

}  // namespace agl
