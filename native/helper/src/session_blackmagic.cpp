// Session backed by the official Blackmagic ATEM Switchers SDK (11.0).
//
// Allowed SDK use (enforced by test/noControl.test.js): discovery/connect,
// read-only getters, media player GetSource, stills Lock/Upload/Unlock and
// callbacks. Nothing here switches, keys, re-routes or clears anything.
//
// Upload sequence follows the SDK manual §4.1.1 and Blackmagic's SwitcherMediaPool
// sample: prepare the frame first, then Lock -> (Obtained) -> Upload ->
// (TransferCompleted/Failed/Cancelled) -> Unlock. Per the sample, a media player
// showing the still keeps the old image until the transfer completes, then swaps.

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <oleauto.h>
#endif

#include "BMDSwitcherAPI.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <type_traits>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "session.h"

#ifndef STDMETHODCALLTYPE
#define STDMETHODCALLTYPE
#endif

namespace agl {

namespace {

// ---------------------------------------------------------------------------
// Platform glue: strings, booleans, IIDs.
#ifdef _WIN32
using SdkString = BSTR;
using SdkBool = BOOL;
using SdkUInt = unsigned int;
using SdkInt = int;
#define AGL_IID(X) __uuidof(X)

bool iidEquals(REFIID a, REFIID b) { return IsEqualIID(a, b) != 0; }
bool isIUnknown(REFIID iid) { return IsEqualIID(iid, __uuidof(IUnknown)) != 0; }

SdkString makeString(const std::string& utf8) {
  const int n = MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, nullptr, 0);
  std::wstring w(n > 0 ? n - 1 : 0, L'\0');
  if (n > 1) MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), -1, w.data(), n);
  return SysAllocString(w.c_str());
}
void freeString(SdkString s) {
  if (s) SysFreeString(s);
}
std::string toUtf8(SdkString s) {
  if (!s) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, s, -1, nullptr, 0, nullptr, nullptr);
  std::string out(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, s, -1, out.data(), n, nullptr, nullptr);
  return out;
}
#else
using SdkString = CFStringRef;
using SdkBool = bool;
using SdkUInt = uint32_t;
using SdkInt = int32_t;
#define AGL_IID(X) IID_##X

bool iidEquals(REFIID a, REFIID b) { return std::memcmp(&a, &b, sizeof(REFIID)) == 0; }
bool isIUnknown(REFIID iid) {
  const CFUUIDBytes unk = CFUUIDGetUUIDBytes(IUnknownUUID);
  return std::memcmp(&iid, &unk, sizeof(REFIID)) == 0;
}

SdkString makeString(const std::string& utf8) {
  return CFStringCreateWithCString(kCFAllocatorDefault, utf8.c_str(), kCFStringEncodingUTF8);
}
void freeString(SdkString s) {
  if (s) CFRelease(s);
}
std::string toUtf8(SdkString s) {
  if (!s) return {};
  const CFIndex len = CFStringGetLength(s);
  const CFIndex max = CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8) + 1;
  std::string out(static_cast<size_t>(max), '\0');
  if (!CFStringGetCString(s, out.data(), max, kCFStringEncodingUTF8)) return {};
  out.resize(std::strlen(out.c_str()));
  return out;
}
#endif

template <typename T>
void releaseAndNull(T*& p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

std::string hr(HRESULT r) {
  char buf[16];
  std::snprintf(buf, sizeof buf, "0x%08X", static_cast<unsigned>(r));
  return buf;
}

// Width/height from the video mode four-character code ('10p9', '72p0', '4H59', ...).
bool videoModeSize(BMDSwitcherVideoMode mode, int& w, int& h) {
  const unsigned m = static_cast<unsigned>(mode);
  const char a = char((m >> 24) & 0xff), b = char((m >> 16) & 0xff);
  if (a == 'n' || (a == 'p' && b == 'a')) {  // 'ntsc' 'ntsA' / 'pall' 'palA'
    w = 720;
    h = (a == 'n') ? 486 : 576;
  } else if (a == '7' && b == '2') {
    w = 1280, h = 720;
  } else if (a == '1' && b == '0') {
    w = 1920, h = 1080;
  } else if (a == '4' && b == 'H') {
    w = 3840, h = 2160;
  } else if (a == '8' && b == 'H') {
    w = 7680, h = 4320;
  } else {
    return false;
  }
  return true;
}

std::string connectFailText(BMDSwitcherConnectToFailure f) {
  switch (f) {
    case bmdSwitcherConnectToFailureNoResponse:
      return "no response from switcher";
    case bmdSwitcherConnectToFailureIncompatibleFirmware:
      return "switcher firmware is incompatible with the installed ATEM software/SDK";
    case bmdSwitcherConnectToFailureCorruptData:
      return "corrupt data from switcher";
    case bmdSwitcherConnectToFailureStateSync:
      return "state synchronisation failed";
    case bmdSwitcherConnectToFailureStateSyncTimedOut:
      return "state synchronisation timed out";
    default:
      return "connection failed";
  }
}

// ---------------------------------------------------------------------------
// Minimal COM object base: ref counting + QueryInterface for one interface.
template <typename Iface>
class ComCallback : public Iface {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* ppv) override {
    if (!ppv) return E_POINTER;
    if (iidEquals(iid, iid_) || isIUnknown(iid)) {
      *ppv = static_cast<Iface*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG n = --refs_;
    if (n == 0) delete this;
    return n;
  }

 protected:
  explicit ComCallback(REFIID iid) : iid_(iid) {}
  virtual ~ComCallback() = default;

 private:
  std::atomic<ULONG> refs_{1};
  std::remove_cv_t<std::remove_reference_t<REFIID>> iid_;  // IID on Windows, CFUUIDBytes on macOS
};

struct Shared;  // state shared between the session and its callbacks

class SwitcherCallback final : public ComCallback<IBMDSwitcherCallback> {
 public:
  explicit SwitcherCallback(Shared* s) : ComCallback(AGL_IID(IBMDSwitcherCallback)), s_(s) {}
  HRESULT STDMETHODCALLTYPE Notify(BMDSwitcherEventType eventType, BMDSwitcherVideoMode) override;

 private:
  Shared* s_;
};

class StillsCallback final : public ComCallback<IBMDSwitcherStillsCallback> {
 public:
  explicit StillsCallback(Shared* s) : ComCallback(AGL_IID(IBMDSwitcherStillsCallback)), s_(s) {}
  HRESULT STDMETHODCALLTYPE Notify(BMDSwitcherMediaPoolEventType eventType, IBMDSwitcherFrame*, SdkInt index) override;

 private:
  Shared* s_;
};

class LockCallback final : public ComCallback<IBMDSwitcherLockCallback> {
 public:
  explicit LockCallback(Shared* s) : ComCallback(AGL_IID(IBMDSwitcherLockCallback)), s_(s) {}
  HRESULT STDMETHODCALLTYPE Obtained() override;

 private:
  Shared* s_;
};

class PlayerCallback final : public ComCallback<IBMDSwitcherMediaPlayerCallback> {
 public:
  explicit PlayerCallback(Shared* s) : ComCallback(AGL_IID(IBMDSwitcherMediaPlayerCallback)), s_(s) {}
  HRESULT STDMETHODCALLTYPE SourceChanged() override;
  HRESULT STDMETHODCALLTYPE PlayingChanged() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE LoopChanged() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE AtBeginningChanged() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE ClipFrameChanged() override { return S_OK; }

 private:
  Shared* s_;
};

enum class TransferResult { None, Completed, Failed, Cancelled };

struct Shared {
  std::mutex m;
  std::condition_variable cv;
  bool lockObtained = false;
  int transferIndex = -1;
  TransferResult transfer = TransferResult::None;
  std::atomic<bool> connected{false};
  SessionEvents* events = nullptr;

  void stateChanged() {
    if (events && events->stateChanged) events->stateChanged();
  }
};

HRESULT SwitcherCallback::Notify(BMDSwitcherEventType eventType, BMDSwitcherVideoMode) {
  if (eventType == bmdSwitcherEventTypeDisconnected) {
    {
      std::lock_guard<std::mutex> l(s_->m);
      s_->connected = false;
    }
    s_->cv.notify_all();
    if (s_->events && s_->events->disconnected) s_->events->disconnected("switcher disconnected");
  } else if (eventType == bmdSwitcherEventTypeVideoModeChanged) {
    s_->stateChanged();
  }
  return S_OK;
}

HRESULT StillsCallback::Notify(BMDSwitcherMediaPoolEventType eventType, IBMDSwitcherFrame*, SdkInt index) {
  TransferResult r = TransferResult::None;
  switch (eventType) {
    case bmdSwitcherMediaPoolEventTypeTransferCompleted:
      r = TransferResult::Completed;
      break;
    case bmdSwitcherMediaPoolEventTypeTransferFailed:
      r = TransferResult::Failed;
      break;
    case bmdSwitcherMediaPoolEventTypeTransferCancelled:
      r = TransferResult::Cancelled;
      break;
    case bmdSwitcherMediaPoolEventTypeValidChanged:
    case bmdSwitcherMediaPoolEventTypeNameChanged:
      s_->stateChanged();
      return S_OK;
    default:
      return S_OK;
  }
  {
    std::lock_guard<std::mutex> l(s_->m);
    if (s_->transferIndex == static_cast<int>(index) || index < 0) s_->transfer = r;
  }
  s_->cv.notify_all();
  return S_OK;
}

HRESULT LockCallback::Obtained() {
  {
    std::lock_guard<std::mutex> l(s_->m);
    s_->lockObtained = true;
  }
  s_->cv.notify_all();
  return S_OK;
}

HRESULT PlayerCallback::SourceChanged() {
  s_->stateChanged();
  return S_OK;
}

// ---------------------------------------------------------------------------
class BlackmagicSession final : public Session {
 public:
  BlackmagicSession() {
#ifdef _WIN32
    // Multithreaded apartment: SDK callbacks arrive on SDK threads without a message pump.
    comInit_ = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
#endif
    shared_.events = &events_;
  }

  ~BlackmagicSession() override {
    disconnect();
    releaseAndNull(discovery_);
#ifdef _WIN32
    if (comInit_) CoUninitialize();
#endif
  }

  std::string kind() const override { return "blackmagic"; }

  bool available(std::string& reason) override {
    if (discovery_) return true;
#ifdef _WIN32
    const HRESULT r = CoCreateInstance(__uuidof(CBMDSwitcherDiscovery), nullptr, CLSCTX_ALL,
                                       __uuidof(IBMDSwitcherDiscovery), reinterpret_cast<void**>(&discovery_));
    if (FAILED(r) || !discovery_) {
      discovery_ = nullptr;
      reason = "Blackmagic ATEM Switchers software (11.0 or newer) is not installed (" + hr(r) + ")";
      return false;
    }
#else
    discovery_ = CreateBMDSwitcherDiscoveryInstance();
    if (!discovery_) {
      reason = "Blackmagic ATEM Switchers software (11.0 or newer) is not installed";
      return false;
    }
#endif
    return true;
  }

  bool connect(Transport t, const std::string& address, std::string& err) override {
    disconnect();
    std::string why;
    if (!available(why)) {
      err = why;
      return false;
    }
    // Empty address = USB only (SDK manual §2.3.1.1).
    SdkString addr = makeString(t == Transport::Usb ? std::string() : address);
    BMDSwitcherConnectToFailure fail = bmdSwitcherConnectToFailureNoResponse;
    const HRESULT r = discovery_->ConnectTo(addr, &switcher_, &fail);
    freeString(addr);
    if (FAILED(r) || !switcher_) {
      switcher_ = nullptr;
      err = connectFailText(fail);
      return false;
    }
    if (FAILED(switcher_->QueryInterface(AGL_IID(IBMDSwitcherMediaPool), reinterpret_cast<void**>(&pool_))) || !pool_) {
      err = "switcher has no media pool";
      disconnect();
      return false;
    }
    if (FAILED(pool_->GetStills(&stills_)) || !stills_) {
      err = "could not access media pool stills";
      disconnect();
      return false;
    }
    IBMDSwitcherMediaPlayerIterator* it = nullptr;
    if (SUCCEEDED(switcher_->CreateIterator(AGL_IID(IBMDSwitcherMediaPlayerIterator), reinterpret_cast<LPVOID*>(&it))) && it) {
      IBMDSwitcherMediaPlayer* p = nullptr;
      while (it->Next(&p) == S_OK && p) players_.push_back(p);
      it->Release();
    }

    switcherCb_ = new SwitcherCallback(&shared_);
    stillsCb_ = new StillsCallback(&shared_);
    lockCb_ = new LockCallback(&shared_);
    playerCb_ = new PlayerCallback(&shared_);
    switcher_->AddCallback(switcherCb_);
    stills_->AddCallback(stillsCb_);
    for (auto* p : players_) p->AddCallback(playerCb_);
    shared_.connected = true;
    return true;
  }

  void disconnect() override {
    shared_.connected = false;
    shared_.cv.notify_all();
    if (holdingLock_ && stills_) {
      stills_->Unlock(lockCb_);
      holdingLock_ = false;
    }
    for (auto* p : players_) {
      if (playerCb_) p->RemoveCallback(playerCb_);
      p->Release();
    }
    players_.clear();
    if (stills_ && stillsCb_) stills_->RemoveCallback(stillsCb_);
    if (switcher_ && switcherCb_) switcher_->RemoveCallback(switcherCb_);
    releaseAndNull(stills_);
    releaseAndNull(pool_);
    releaseAndNull(switcher_);
    releaseAndNull(switcherCb_);
    releaseAndNull(stillsCb_);
    releaseAndNull(lockCb_);
    releaseAndNull(playerCb_);
  }

  bool connected() const override { return shared_.connected && switcher_ != nullptr; }

  bool snapshot(Snapshot& out, std::string& err) override {
    if (!connected()) {
      err = "not connected";
      return false;
    }
    BMDSwitcherVideoMode mode;
    if (FAILED(switcher_->GetVideoMode(&mode)) || !videoModeSize(mode, out.width, out.height)) {
      err = "unknown switcher video mode";
      return false;
    }
    SdkString name = nullptr;
    if (SUCCEEDED(switcher_->GetProductName(&name))) out.productName = toUtf8(name);
    freeString(name);

    out.players.clear();
    for (auto* p : players_) {
      BMDSwitcherMediaPlayerSourceType type;
      SdkUInt index = 0;
      PlayerInfo info;
      if (SUCCEEDED(p->GetSource(&type, &index))) {
        info.sourceType = (type == bmdSwitcherMediaPlayerSourceTypeStill) ? 1 : 2;
        info.stillIndex = static_cast<int>(index);
      }
      out.players.push_back(info);
    }

    out.stills.clear();
    SdkUInt count = 0;
    if (SUCCEEDED(stills_->GetCount(&count))) {
      for (SdkUInt i = 0; i < count; ++i) {
        StillInfo s;
        SdkBool valid = false;
        if (SUCCEEDED(stills_->IsValid(i, &valid))) s.used = valid != 0;
        SdkString n = nullptr;
        if (SUCCEEDED(stills_->GetName(i, &n))) s.name = toUtf8(n);
        freeString(n);
        out.stills.push_back(s);
      }
    }
    return true;
  }

  // 8BitARGB frames are filled with B,G,R,A bytes in memory, exactly as Blackmagic's
  // SwitcherMediaPool sample copies 32-bit TGA data (which is stored BGRA).
  PixelLayout frameLayout() const override { return PixelLayout::BGRA; }

  bool uploadStill(int stillIndex, const Image& image, const std::string& name, std::string& err) override {
    if (!connected()) {
      err = "not connected";
      return false;
    }

    // 1. Prepare the frame before taking the lock (as the SDK sample advises).
    IBMDSwitcherFrame* frame = nullptr;
    HRESULT r = pool_->CreateFrame(bmdSwitcherPixelFormat8BitARGB, static_cast<SdkUInt>(image.width),
                                   static_cast<SdkUInt>(image.height), &frame);
    if (FAILED(r) || !frame) {
      err = "could not create frame (" + hr(r) + ")";
      return false;
    }
    void* bytes = nullptr;
    if (FAILED(frame->GetBytes(&bytes)) || !bytes || frame->GetWidth() != image.width ||
        frame->GetHeight() != image.height) {
      frame->Release();
      err = "frame buffer unavailable or wrong size";
      return false;
    }
    const size_t srcRow = static_cast<size_t>(image.width) * 4;
    const size_t dstRow = static_cast<size_t>(frame->GetRowBytes());
    for (int y = 0; y < image.height; ++y) {
      std::memcpy(static_cast<uint8_t*>(bytes) + y * dstRow, image.pixels.data() + y * srcRow, srcRow);
    }

    // 2. Lock the stills pool.
    {
      std::lock_guard<std::mutex> l(shared_.m);
      shared_.lockObtained = false;
      shared_.transfer = TransferResult::None;
      shared_.transferIndex = stillIndex;
    }
    r = stills_->Lock(lockCb_);
    if (FAILED(r)) {
      frame->Release();
      err = "could not request media pool lock (" + hr(r) + ")";
      return false;
    }
    holdingLock_ = true;  // Unlock is safe even if the lock never arrived; it cancels the request.
    if (!waitFor([&] { return shared_.lockObtained; }, std::chrono::seconds(10))) {
      finish(frame);
      err = shared_.connected ? "media pool is locked by another client (is ATEM Software Control uploading?)"
                              : "switcher disconnected";
      return false;
    }

    // 3. Upload. Do not touch the frame buffer until the transfer ends.
    SdkString sname = makeString(name);
    r = stills_->Upload(static_cast<SdkUInt>(stillIndex), sname, frame);
    freeString(sname);
    if (FAILED(r)) {
      finish(frame);
      err = (r == E_ACCESSDENIED) ? "media pool lock was not held" : "upload rejected (" + hr(r) + ")";
      return false;
    }

    // 4. Wait for the switcher to finish (generous: full-frame 4K over a slow link).
    const bool ended = waitFor([&] { return shared_.transfer != TransferResult::None; }, std::chrono::seconds(60));
    if (!ended) {
      if (shared_.connected) stills_->CancelTransfer();
      finish(frame);
      err = shared_.connected ? "transfer timed out" : "switcher disconnected during transfer";
      return false;
    }
    const TransferResult result = shared_.transfer;
    finish(frame);  // 5. Unlock so other clients (e.g. ATEM Software Control) can transfer.
    if (result != TransferResult::Completed) {
      err = result == TransferResult::Cancelled ? "transfer cancelled by switcher" : "transfer failed";
      return false;
    }
    return true;
  }

 private:
  template <typename Pred>
  bool waitFor(Pred pred, std::chrono::seconds timeout) {
    std::unique_lock<std::mutex> l(shared_.m);
    shared_.cv.wait_for(l, timeout, [&] { return pred() || !shared_.connected; });
    return pred();
  }

  void finish(IBMDSwitcherFrame* frame) {
    if (holdingLock_ && stills_) stills_->Unlock(lockCb_);
    holdingLock_ = false;
    if (frame) frame->Release();
    std::lock_guard<std::mutex> l(shared_.m);
    shared_.transferIndex = -1;
  }

  Shared shared_;
  IBMDSwitcherDiscovery* discovery_ = nullptr;
  IBMDSwitcher* switcher_ = nullptr;
  IBMDSwitcherMediaPool* pool_ = nullptr;
  IBMDSwitcherStills* stills_ = nullptr;
  std::vector<IBMDSwitcherMediaPlayer*> players_;
  SwitcherCallback* switcherCb_ = nullptr;
  StillsCallback* stillsCb_ = nullptr;
  LockCallback* lockCb_ = nullptr;
  PlayerCallback* playerCb_ = nullptr;
  bool holdingLock_ = false;
#ifdef _WIN32
  bool comInit_ = false;
#endif
};

}  // namespace

std::unique_ptr<Session> createSession() { return std::make_unique<BlackmagicSession>(); }

}  // namespace agl
