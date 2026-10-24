#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace agl {

// Byte order of a 32-bit pixel in memory.
enum class PixelLayout { RGBA, BGRA, ARGB };

struct Image {
  int width = 0;
  int height = 0;
  PixelLayout layout = PixelLayout::RGBA;
  std::vector<uint8_t> pixels;  // width * height * 4
};

// Decode a PNG to RGBA exactly as stored: no premultiply, no gamma/colour management.
// Already-premultiplied files therefore stay premultiplied.
bool loadPng(const std::string& path, Image& out, std::string& err);

// Reorder channels in place. Pure byte shuffle: values are never scaled.
void convertLayout(Image& img, PixelLayout target);

}  // namespace agl
