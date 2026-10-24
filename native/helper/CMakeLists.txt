cmake_minimum_required(VERSION 3.16)
project(agl_helper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Path to the unzipped Blackmagic ATEM Switchers SDK (the folder that contains
# Windows/ and Mac OS X/ include directories). Leave empty to build without it;
# the app then uses its Ethernet (atem-connection) backend only.
set(AGL_ATEM_SDK_DIR "" CACHE PATH "Blackmagic ATEM Switchers SDK root")

set(COMMON_SOURCES src/main.cpp src/image.cpp)
set(COMMON_INCLUDES src third_party)

if(MSVC)
  set(COMMON_OPTIONS /W3 /utf-8 /EHsc)
  # Static runtime: the helper .exe runs without a VC++ redistributable installed.
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
else()
  set(COMMON_OPTIONS -Wall -Wextra -Wno-unused-parameter)
endif()

find_package(Threads REQUIRED)

# --- Shipped helper -----------------------------------------------------------
set(SESSION_SOURCE src/session_nosdk.cpp)
set(SDK_INCLUDES "")
set(SDK_LIBS "")
set(AGL_SDK_KIND none)

if(AGL_ATEM_SDK_DIR)
  if(WIN32)
    set(SESSION_SOURCE src/session_blackmagic.cpp)
    # SdkSession implementation is added once the SDK is in hand.
  elseif(APPLE)
    set(SESSION_SOURCE src/session_blackmagic.cpp)
  endif()
  if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/${SESSION_SOURCE}")
    message(FATAL_ERROR "AGL_ATEM_SDK_DIR is set but ${SESSION_SOURCE} is not implemented yet")
  endif()
  set(AGL_SDK_KIND blackmagic)
endif()

add_executable(agl-helper ${COMMON_SOURCES} ${SESSION_SOURCE})
target_include_directories(agl-helper PRIVATE ${COMMON_INCLUDES} ${SDK_INCLUDES})
target_compile_options(agl-helper PRIVATE ${COMMON_OPTIONS})
target_link_libraries(agl-helper PRIVATE Threads::Threads ${SDK_LIBS})
message(STATUS "agl-helper session: ${AGL_SDK_KIND}")

# --- Test-only helper with a simulated switcher (never shipped) ---------------
option(AGL_BUILD_MOCK "Build agl-helper-mock for automated tests" ON)
if(AGL_BUILD_MOCK)
  add_executable(agl-helper-mock ${COMMON_SOURCES} src/session_mock.cpp)
  target_include_directories(agl-helper-mock PRIVATE ${COMMON_INCLUDES})
  target_compile_options(agl-helper-mock PRIVATE ${COMMON_OPTIONS})
  target_link_libraries(agl-helper-mock PRIVATE Threads::Threads)
endif()
