// agl-helper: isolated process that talks to the switcher for ATEM Graphics Launcher.
//
// Protocol: one JSON object per line on stdin (requests) and stdout (responses/events).
// See docs/HELPER_PROTOCOL.md. Diagnostics go to stderr.

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <iostream>
#include <list>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#include "image.h"
#include "json.hpp"
#include "session.h"

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {

constexpr int kProtocolVersion = 1;
constexpr const char* kHelperVersion = "1.1.0";

std::mutex g_outMutex;

void writeLine(const json& j) {
  const std::string s = j.dump(-1, ' ', false, json::error_handler_t::replace);
  std::lock_guard<std::mutex> lock(g_outMutex);
  std::fwrite(s.data(), 1, s.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void logLine(const std::string& msg) {
  std::lock_guard<std::mutex> lock(g_outMutex);
  std::fprintf(stderr, "[agl-helper] %s\n", msg.c_str());
  std::fflush(stderr);
}

fs::path toPath(const std::string& utf8) {
#if defined(_WIN32)
  return fs::u8path(utf8);
#else
  return fs::path(utf8);
#endif
}

json snapshotToJson(const agl::Snapshot& s) {
  json players = json::array();
  for (const auto& p : s.players) players.push_back({{"sourceType", p.sourceType}, {"stillIndex", p.stillIndex}});
  json stills = json::array();
  for (const auto& st : s.stills) stills.push_back({{"used", st.used}, {"name", st.name}});
  return {{"width", s.width}, {"height", s.height}, {"productName", s.productName}, {"players", players}, {"stills", stills}};
}

// ---------------------------------------------------------------------------
// Cache of decoded, layout-converted frames so a click only has to copy and send.
class FrameCache {
 public:
  explicit FrameCache(size_t maxBytes) : maxBytes_(maxBytes) {}

  // Returns nullptr and sets err on failure.
  const agl::Image* get(const std::string& path, agl::PixelLayout layout, std::string& err, bool& wasCached) {
    std::error_code ec;
    const fs::path p = toPath(path);
    const auto size = fs::file_size(p, ec);
    if (ec) {
      err = "cannot read file";
      return nullptr;
    }
    // libc++ (macOS) uses a 128-bit rep for file times; normalise to 64-bit nanoseconds.
    const long long mtime = static_cast<long long>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(fs::last_write_time(p, ec).time_since_epoch()).count());
    const std::string sig = std::to_string(size) + ":" + std::to_string(mtime) + ":" + std::to_string(int(layout));
    auto it = map_.find(path);
    if (it != map_.end()) {
      if (it->second.sig == sig) {
        wasCached = true;
        touch(it);
        return &it->second.image;
      }
      erase(it);
    }
    wasCached = false;
    Entry e;
    e.sig = sig;
    if (!agl::loadPng(path, e.image, err)) return nullptr;
    agl::convertLayout(e.image, layout);
    const size_t bytes = e.image.pixels.size();
    while (bytes_ + bytes > maxBytes_ && !lru_.empty()) erase(map_.find(lru_.back()));
    lru_.push_front(path);
    e.lruIt = lru_.begin();
    bytes_ += bytes;
    auto res = map_.emplace(path, std::move(e));
    return &res.first->second.image;
  }

  void clear() {
    map_.clear();
    lru_.clear();
    bytes_ = 0;
  }

  size_t bytes() const { return bytes_; }
  size_t size() const { return map_.size(); }

 private:
  struct Entry {
    std::string sig;
    agl::Image image;
    std::list<std::string>::iterator lruIt;
  };
  using Map = std::unordered_map<std::string, Entry>;

  void touch(Map::iterator it) {
    lru_.erase(it->second.lruIt);
    lru_.push_front(it->first);
    it->second.lruIt = lru_.begin();
  }
  void erase(Map::iterator it) {
    if (it == map_.end()) return;
    bytes_ -= it->second.image.pixels.size();
    lru_.erase(it->second.lruIt);
    map_.erase(it);
  }

  size_t maxBytes_;
  size_t bytes_ = 0;
  Map map_;
  std::list<std::string> lru_;
};

// ---------------------------------------------------------------------------
struct Queue {
  std::mutex m;
  std::condition_variable cv;
  std::deque<json> items;
  void push(json j) {
    {
      std::lock_guard<std::mutex> l(m);
      items.push_back(std::move(j));
    }
    cv.notify_one();
  }
  json pop() {
    std::unique_lock<std::mutex> l(m);
    cv.wait(l, [&] { return !items.empty(); });
    json j = std::move(items.front());
    items.pop_front();
    return j;
  }
};

json ok(const json& id, json result = json::object()) { return {{"id", id}, {"ok", true}, {"result", std::move(result)}}; }

json fail(const json& id, const std::string& code, const std::string& msg) {
  return {{"id", id}, {"ok", false}, {"code", code}, {"error", msg}};
}

}  // namespace

int main() {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif

  auto session = agl::createSession();
  FrameCache cache(size_t(1536) * 1024 * 1024);  // ~180 decoded 1080p frames
  Queue queue;
  std::atomic<bool> statePending{false};
  agl::Snapshot lastSnapshot;

  session->setEvents({
      [&](const std::string& reason) {
        writeLine({{"event", "connection"}, {"status", "disconnected"}, {"message", reason}});
      },
      [&]() {
        // SDK callbacks arrive on SDK threads: never call back into the SDK from here.
        if (!statePending.exchange(true)) queue.push({{"cmd", "__emit_state"}});
      },
  });

  std::thread reader([&] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) continue;
      try {
        queue.push(json::parse(line));
      } catch (const std::exception& e) {
        writeLine({{"event", "log"}, {"message", std::string("bad request: ") + e.what()}});
      }
    }
    queue.push({{"cmd", "shutdown"}});
  });
  reader.detach();

  auto refreshSnapshot = [&](std::string& err) -> bool {
    agl::Snapshot s;
    if (!session->snapshot(s, err)) return false;
    lastSnapshot = s;
    return true;
  };

  for (;;) {
    json req = queue.pop();
    const json id = req.value("id", json());
    const std::string cmd = req.value("cmd", "");
    try {
      if (cmd == "shutdown") {
        session->disconnect();
        if (!id.is_null()) writeLine(ok(id));
        return 0;
      } else if (cmd == "__emit_state") {
        statePending = false;
        std::string err;
        if (session->connected() && refreshSnapshot(err)) {
          json ev = snapshotToJson(lastSnapshot);
          ev["event"] = "state";
          writeLine(ev);
        }
      } else if (cmd == "hello") {
        std::string reason;
        const bool avail = session->available(reason);
        writeLine(ok(id, {{"protocol", kProtocolVersion},
                          {"helperVersion", kHelperVersion},
                          {"sdk", session->kind()},
                          {"sdkAvailable", avail},
                          {"reason", reason}}));
      } else if (cmd == "connect") {
        const std::string t = req.value("transport", "usb");
        const std::string address = req.value("address", "");
        const auto transport = t == "network" ? agl::Transport::Network : agl::Transport::Usb;
        std::string err;
        std::string reason;
        if (!session->available(reason)) {
          writeLine(fail(id, "sdk_unavailable", reason));
          continue;
        }
        if (transport == agl::Transport::Network && address.empty()) {
          writeLine(fail(id, "bad_request", "network connection needs an address"));
          continue;
        }
        cache.clear();
        if (!session->connect(transport, address, err)) {
          writeLine(fail(id, "connect_failed", err));
          continue;
        }
        if (!refreshSnapshot(err)) {
          session->disconnect();
          writeLine(fail(id, "connect_failed", "connected but could not read switcher state: " + err));
          continue;
        }
        writeLine(ok(id, snapshotToJson(lastSnapshot)));
        writeLine({{"event", "connection"}, {"status", "connected"}, {"transport", t}});
      } else if (cmd == "disconnect") {
        session->disconnect();
        cache.clear();
        writeLine(ok(id));
      } else if (cmd == "state") {
        std::string err;
        if (!session->connected()) {
          writeLine(fail(id, "not_connected", "not connected"));
        } else if (!refreshSnapshot(err)) {
          writeLine(fail(id, "state_failed", err));
        } else {
          writeLine(ok(id, snapshotToJson(lastSnapshot)));
        }
      } else if (cmd == "prepare") {
        const std::string path = req.value("path", "");
        std::string err;
        bool cached = false;
        const auto t0 = std::chrono::steady_clock::now();
        const agl::Image* img = cache.get(path, session->frameLayout(), err, cached);
        const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        if (!img)
          writeLine(fail(id, "bad_file", err));
        else
          writeLine(ok(id, {{"cached", cached}, {"ms", ms}, {"cacheBytes", cache.bytes()}}));
      } else if (cmd == "upload") {
        const int stillIndex = req.value("stillIndex", -1);
        const std::string path = req.value("path", "");
        const std::string name = req.value("name", "");
        if (!session->connected()) {
          writeLine(fail(id, "not_connected", "not connected to the switcher"));
          continue;
        }
        if (stillIndex < 0 || (!lastSnapshot.stills.empty() && stillIndex >= int(lastSnapshot.stills.size()))) {
          writeLine(fail(id, "bad_request", "still index out of range"));
          continue;
        }
        std::string err;
        bool cached = false;
        const auto t0 = std::chrono::steady_clock::now();
        const agl::Image* img = cache.get(path, session->frameLayout(), err, cached);
        if (!img) {
          writeLine(fail(id, "bad_file", err));
          continue;
        }
        if (img->width != lastSnapshot.width || img->height != lastSnapshot.height) {
          writeLine(fail(id, "size_mismatch",
                         "Graphic is " + std::to_string(img->width) + "x" + std::to_string(img->height) +
                             " but the switcher is running " + std::to_string(lastSnapshot.width) + "x" +
                             std::to_string(lastSnapshot.height)));
          continue;
        }
        const auto t1 = std::chrono::steady_clock::now();
        if (!session->uploadStill(stillIndex, *img, name, err)) {
          writeLine(fail(id, "transfer_failed", err));
          continue;
        }
        const auto t2 = std::chrono::steady_clock::now();
        writeLine(ok(id, {{"prepared", cached},
                          {"prepareMs", std::chrono::duration<double, std::milli>(t1 - t0).count()},
                          {"transferMs", std::chrono::duration<double, std::milli>(t2 - t1).count()}}));
      } else {
        if (!id.is_null()) writeLine(fail(id, "bad_request", "unknown command: " + cmd));
      }
    } catch (const std::exception& e) {
      logLine(std::string("error handling ") + cmd + ": " + e.what());
      if (!id.is_null()) writeLine(fail(id, "internal", e.what()));
    }
  }
}
