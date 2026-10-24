#include "image.h"

#include <cstdio>
#include <cstring>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_NO_STDIO_WRITE
#include "stb_image.h"

namespace agl {

bool loadPng(const std::string& path, Image& out, std::string& err) {
  // stb_image applies no gamma and no premultiplication to PNG data.
  // (stbi_set_unpremultiply_on_load only affects Apple-crushed iPhone PNGs, left off.)
  int w = 0, h = 0, comp = 0;
#ifdef _WIN32
  // Windows paths may be UTF-8 with non-ASCII characters: open via _wfopen.
  int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  std::wstring wpath(wlen, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath.data(), wlen);
  FILE* f = _wfopen(wpath.c_str(), L"rb");
#else
  FILE* f = std::fopen(path.c_str(), "rb");
#endif
  if (!f) {
    err = "cannot open file";
    return false;
  }
  unsigned char* data = stbi_load_from_file(f, &w, &h, &comp, 4);
  std::fclose(f);
  if (!data) {
    err = std::string("not a readable PNG: ") + (stbi_failure_reason() ? stbi_failure_reason() : "unknown");
    return false;
  }
  out.width = w;
  out.height = h;
  out.layout = PixelLayout::RGBA;
  out.pixels.assign(data, data + static_cast<size_t>(w) * h * 4);
  stbi_image_free(data);
  return true;
}

void convertLayout(Image& img, PixelLayout target) {
  if (img.layout == target) return;
  // Normalise to RGBA first, then to target.
  auto toRGBA = [](uint8_t* p, PixelLayout from) {
    const uint8_t a = p[0], b = p[1], c = p[2], d = p[3];
    switch (from) {
      case PixelLayout::BGRA:  // B G R A
        p[0] = c, p[1] = b, p[2] = a, p[3] = d;
        break;
      case PixelLayout::ARGB:  // A R G B
        p[0] = b, p[1] = c, p[2] = d, p[3] = a;
        break;
      default:
        break;
    }
  };
  auto fromRGBA = [](uint8_t* p, PixelLayout to) {
    uint8_t r = p[0], g = p[1], b = p[2], a = p[3];
    switch (to) {
      case PixelLayout::BGRA:
        p[0] = b, p[1] = g, p[2] = r, p[3] = a;
        break;
      case PixelLayout::ARGB:
        p[0] = a, p[1] = r, p[2] = g, p[3] = b;
        break;
      default:
        break;
    }
  };
  uint8_t* p = img.pixels.data();
  const size_t n = img.pixels.size();
  for (size_t i = 0; i + 3 < n; i += 4) {
    if (img.layout != PixelLayout::RGBA) toRGBA(p + i, img.layout);
    if (target != PixelLayout::RGBA) fromRGBA(p + i, target);
  }
  img.layout = target;
}

}  // namespace agl
