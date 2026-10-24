cmake_minimum_required(VERSION 3.16)
project(agl_helper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

if(MSVC)
  # Static runtime: the helper .exe runs without a VC++ redistributable installed.
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set(COMMON_SOURCES src/main.cpp src/image.cpp)
set(COMMON_INCLUDES src third_party)
if(MSVC)
  set(COMMON_OPTIONS /W3 /utf-8 /EHsc)
else()
  set(COMMON_OPTIONS -Wall -Wextra -Wno-unused-parameter)
endif()

find_package(Threads REQUIRED)

# --- Shipped helper -----------------------------------------------------------
# Uses the Blackmagic ATEM Switchers SDK (vendored headers in sdk/) on Windows and
# macOS. The SDK library itself comes from the ATEM Switchers software installed
# on the machine; if it is missing the helper reports "sdk_unavailable" and the app
# falls back to Ethernet.
option(AGL_WITH_BLACKMAGIC_SDK "Build agl-helper with the Blackmagic SDK session" ON)

set(SESSION_SOURCES src/session_nosdk.cpp)
set(SDK_INCLUDES "")
set(SDK_LIBS "")
set(AGL_SDK_KIND none)

if(AGL_WITH_BLACKMAGIC_SDK AND WIN32)
  set(SESSION_SOURCES src/session_blackmagic.cpp)
  set(SDK_INCLUDES sdk/windows)
  set(SDK_LIBS ole32 oleaut32)
  set(AGL_SDK_KIND blackmagic)
elseif(AGL_WITH_BLACKMAGIC_SDK AND APPLE)
  set(SESSION_SOURCES src/session_blackmagic.cpp sdk/mac/BMDSwitcherAPIDispatch.cpp)
  set(SDK_INCLUDES sdk/mac)
  set(SDK_LIBS "-framework CoreFoundation")
  set(AGL_SDK_KIND blackmagic)
endif()

add_executable(agl-helper ${COMMON_SOURCES} ${SESSION_SOURCES})
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
