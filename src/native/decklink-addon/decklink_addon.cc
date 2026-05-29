#include <napi.h>
#include <string>
#include <cstdlib>
#include <atomic>
#include <chrono>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include <CoreFoundation/CoreFoundation.h>

#include "DeckLinkAPI.h"

namespace {
using CreateIteratorFunc = IDeckLinkIterator* (*)(void);

static CFBundleRef gDeckLinkBundleRef = nullptr;
static CreateIteratorFunc gCreateIteratorFunc = nullptr;
static std::string gLoadError;
static bool gInitialized = false;

void InitDeckLinkApi()
{
  if (gInitialized)
  {
    return;
  }

  gInitialized = true;

  const char* envPath = std::getenv("DECKLINK_FRAMEWORK_PATH");
  const char* bundlePath = envPath && envPath[0] != '\0'
    ? envPath
    : "/Library/Frameworks/DeckLinkAPI.framework";

  CFStringRef pathString = CFStringCreateWithCString(kCFAllocatorDefault, bundlePath, kCFStringEncodingUTF8);
  if (!pathString)
  {
    gLoadError = "Failed to create bundle path string.";
    return;
  }

  CFURLRef bundleURL = CFURLCreateWithFileSystemPath(kCFAllocatorDefault, pathString, kCFURLPOSIXPathStyle, true);
  CFRelease(pathString);

  if (!bundleURL)
  {
    gLoadError = "Failed to create bundle URL.";
    return;
  }

  gDeckLinkBundleRef = CFBundleCreate(kCFAllocatorDefault, bundleURL);
  CFRelease(bundleURL);

  if (!gDeckLinkBundleRef)
  {
    gLoadError = "Failed to load DeckLinkAPI.framework.";
    return;
  }

  CFStringRef fnName = CFStringCreateWithCString(kCFAllocatorDefault, "CreateDeckLinkIteratorInstance_0004", kCFStringEncodingUTF8);
  if (fnName)
  {
    gCreateIteratorFunc = reinterpret_cast<CreateIteratorFunc>(CFBundleGetFunctionPointerForName(gDeckLinkBundleRef, fnName));
    CFRelease(fnName);
  }

  if (!gCreateIteratorFunc)
  {
    CFStringRef fallbackName = CFStringCreateWithCString(kCFAllocatorDefault, "CreateDeckLinkIteratorInstance", kCFStringEncodingUTF8);
    if (fallbackName)
    {
      gCreateIteratorFunc = reinterpret_cast<CreateIteratorFunc>(CFBundleGetFunctionPointerForName(gDeckLinkBundleRef, fallbackName));
      CFRelease(fallbackName);
    }
  }

  if (!gCreateIteratorFunc)
  {
    gLoadError = "DeckLink iterator symbol not found in framework.";
  }
}

bool IsDeckLinkApiPresent()
{
  InitDeckLinkApi();
  return gDeckLinkBundleRef != nullptr;
}

CreateIteratorFunc GetCreateIteratorFunc()
{
  InitDeckLinkApi();
  return gCreateIteratorFunc;
}

std::string GetLoadError()
{
  InitDeckLinkApi();
  return gLoadError;
}

std::string CfStringToStdString(CFStringRef value)
{
  if (!value)
  {
    return std::string();
  }

  CFIndex length = CFStringGetLength(value);
  CFIndex maxSize = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8) + 1;
  std::string buffer;
  buffer.resize(static_cast<size_t>(maxSize));

  if (CFStringGetCString(value, buffer.data(), maxSize, kCFStringEncodingUTF8))
  {
    buffer.resize(strlen(buffer.c_str()));
    return buffer;
  }

  return std::string();
}

Napi::Array ListDevices(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  Napi::Array devices = Napi::Array::New(env);

  CreateIteratorFunc createIterator = GetCreateIteratorFunc();
  if (!createIterator)
  {
    return devices;
  }

  IDeckLinkIterator* iterator = createIterator();
  if (!iterator)
  {
    return devices;
  }

  IDeckLink* deckLink = nullptr;
  uint32_t index = 0;

  while (iterator->Next(&deckLink) == S_OK && deckLink)
  {
    CFStringRef displayName = nullptr;
    std::string name;

    if (deckLink->GetDisplayName(&displayName) == S_OK && displayName)
    {
      name = CfStringToStdString(displayName);
      CFRelease(displayName);
    }

    if (name.empty())
    {
      CFStringRef modelName = nullptr;
      if (deckLink->GetModelName(&modelName) == S_OK && modelName)
      {
        name = CfStringToStdString(modelName);
        CFRelease(modelName);
      }
    }

    if (name.empty())
    {
      name = "DeckLink Device";
    }

    devices.Set(index++, Napi::String::New(env, name));
    deckLink->Release();
  }

  iterator->Release();
  return devices;
}

Napi::Object GetDiagnostics(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  Napi::Object diagnostics = Napi::Object::New(env);

  bool apiPresent = IsDeckLinkApiPresent();
  diagnostics.Set("apiPresent", Napi::Boolean::New(env, apiPresent));
  diagnostics.Set("loadError", Napi::String::New(env, GetLoadError()));

  bool iteratorAvailable = false;
  if (apiPresent && GetCreateIteratorFunc())
  {
    IDeckLinkIterator* iterator = GetCreateIteratorFunc()();
    if (iterator)
    {
      iteratorAvailable = true;
      iterator->Release();
    }
  }

  diagnostics.Set("iteratorAvailable", Napi::Boolean::New(env, iteratorAvailable));
  return diagnostics;
}

struct OutputContext
{
  IDeckLink* device = nullptr;
  IDeckLinkOutput* output = nullptr;
  BMDDisplayMode mode = bmdModeHD1080p5994;
  BMDPixelFormat pixelFormat = bmdFormat8BitYUV;
  int width = 1920;
  int height = 1080;
  int bytesPerPixel = 2;
  double fps = 59.94;
  std::atomic<bool> running{false};
  std::thread thread;
  std::mutex frameMutex;
  std::vector<uint8_t> frame;
};

std::mutex gOutputsMutex;
std::map<int, std::shared_ptr<OutputContext>> gOutputs;

bool ResolveMode(const std::string& modeString, BMDDisplayMode& mode, int& width, int& height, double& fps)
{
  width = 1920;
  height = 1080;

  if (modeString == "1080i59.94")
  {
    mode = bmdModeHD1080i5994;
    fps = 29.97;
    return true;
  }
  if (modeString == "1080i50")
  {
    mode = bmdModeHD1080i50;
    fps = 25.0;
    return true;
  }
  if (modeString == "1080p60")
  {
    mode = bmdModeHD1080p6000;
    fps = 60.0;
    return true;
  }
  if (modeString == "1080p59.94")
  {
    mode = bmdModeHD1080p5994;
    fps = 59.94;
    return true;
  }
  if (modeString == "1080p50")
  {
    mode = bmdModeHD1080p50;
    fps = 50.0;
    return true;
  }
  if (modeString == "1080p30")
  {
    mode = bmdModeHD1080p30;
    fps = 30.0;
    return true;
  }
  if (modeString == "1080p29.97")
  {
    mode = bmdModeHD1080p2997;
    fps = 29.97;
    return true;
  }
  if (modeString == "1080p25")
  {
    mode = bmdModeHD1080p25;
    fps = 25.0;
    return true;
  }
  if (modeString == "1080p24")
  {
    mode = bmdModeHD1080p24;
    fps = 24.0;
    return true;
  }
  if (modeString == "1080p23.98")
  {
    mode = bmdModeHD1080p2398;
    fps = 23.98;
    return true;
  }

  return false;
}

std::string ModeToString(BMDDisplayMode mode)
{
  switch (mode)
  {
    case bmdModeHD1080i5994:
      return "1080i59.94";
    case bmdModeHD1080i50:
      return "1080i50";
    case bmdModeHD1080p6000:
      return "1080p60";
    case bmdModeHD1080p5994:
      return "1080p59.94";
    case bmdModeHD1080p50:
      return "1080p50";
    case bmdModeHD1080p30:
      return "1080p30";
    case bmdModeHD1080p2997:
      return "1080p29.97";
    case bmdModeHD1080p25:
      return "1080p25";
    case bmdModeHD1080p24:
      return "1080p24";
    case bmdModeHD1080p2398:
      return "1080p23.98";
    default:
      return "";
  }
}

bool GetDisplayModeDetails(IDeckLinkOutput* output, BMDDisplayMode mode, int& width, int& height, double& fps)
{
  if (!output)
  {
    return false;
  }

  IDeckLinkDisplayModeIterator* iterator = nullptr;
  if (output->GetDisplayModeIterator(&iterator) != S_OK || !iterator)
  {
    return false;
  }

  bool found = false;
  IDeckLinkDisplayMode* displayMode = nullptr;
  while (iterator->Next(&displayMode) == S_OK && displayMode)
  {
    if (displayMode->GetDisplayMode() == mode)
    {
      width = displayMode->GetWidth();
      height = displayMode->GetHeight();

      BMDTimeValue frameDuration = 0;
      BMDTimeScale timeScale = 0;
      if (displayMode->GetFrameRate(&frameDuration, &timeScale) == S_OK && frameDuration > 0)
      {
        fps = static_cast<double>(timeScale) / static_cast<double>(frameDuration);
      }

      found = true;
      displayMode->Release();
      break;
    }
    displayMode->Release();
  }

  iterator->Release();
  return found;
}

bool FindFirstSupportedMode(IDeckLinkOutput* output, BMDDisplayMode& mode, int& width, int& height, double& fps)
{
  if (!output)
  {
    return false;
  }

  IDeckLinkDisplayModeIterator* iterator = nullptr;
  if (output->GetDisplayModeIterator(&iterator) != S_OK || !iterator)
  {
    return false;
  }

  bool found = false;
  IDeckLinkDisplayMode* displayMode = nullptr;
  while (iterator->Next(&displayMode) == S_OK && displayMode)
  {
    const BMDDisplayMode candidate = displayMode->GetDisplayMode();
    bool supported = false;
    BMDDisplayMode actualMode = candidate;
    if (output->DoesSupportVideoMode(bmdVideoConnectionUnspecified, candidate, bmdFormat8BitBGRA, bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actualMode, &supported) == S_OK && supported)
    {
      mode = actualMode;
      width = displayMode->GetWidth();
      height = displayMode->GetHeight();
      BMDTimeValue frameDuration = 0;
      BMDTimeScale timeScale = 0;
      if (displayMode->GetFrameRate(&frameDuration, &timeScale) == S_OK && frameDuration > 0)
      {
        fps = static_cast<double>(timeScale) / static_cast<double>(frameDuration);
      }
      found = true;
      displayMode->Release();
      break;
    }

    supported = false;
    actualMode = candidate;
    if (output->DoesSupportVideoMode(bmdVideoConnectionSDI, candidate, bmdFormat8BitBGRA, bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actualMode, &supported) == S_OK && supported)
    {
      mode = actualMode;
      width = displayMode->GetWidth();
      height = displayMode->GetHeight();
      BMDTimeValue frameDuration = 0;
      BMDTimeScale timeScale = 0;
      if (displayMode->GetFrameRate(&frameDuration, &timeScale) == S_OK && frameDuration > 0)
      {
        fps = static_cast<double>(timeScale) / static_cast<double>(frameDuration);
      }
      found = true;
      displayMode->Release();
      break;
    }
    displayMode->Release();
  }

  iterator->Release();
  return found;
}

void FillBlackFrame(uint8_t* destination, size_t size)
{
  if (!destination || size == 0)
  {
    return;
  }

  for (size_t i = 0; i + 3 < size; i += 4)
  {
    destination[i] = 0;
    destination[i + 1] = 0;
    destination[i + 2] = 0;
    destination[i + 3] = 255;
  }
}

void FillBlackFrameYUV(uint8_t* destination, size_t size)
{
  if (!destination || size == 0)
  {
    return;
  }

  for (size_t i = 0; i + 3 < size; i += 4)
  {
    destination[i] = 128;
    destination[i + 1] = 16;
    destination[i + 2] = 128;
    destination[i + 3] = 16;
  }
}

void OutputThread(std::shared_ptr<OutputContext> context)
{
  if (!context || !context->output)
  {
    return;
  }

  const int rowBytes = context->width * context->bytesPerPixel;
  const auto frameDuration = std::chrono::duration<double>(1.0 / context->fps);

  while (context->running.load())
  {
    IDeckLinkMutableVideoFrame* frame = nullptr;
    if (context->output->CreateVideoFrame(context->width, context->height, rowBytes, context->pixelFormat, bmdFrameFlagDefault, &frame) != S_OK || !frame)
    {
      std::this_thread::sleep_for(frameDuration);
      continue;
    }

    IDeckLinkVideoBuffer* videoBuffer = nullptr;
    if (frame->QueryInterface(IID_IDeckLinkVideoBuffer, (void**)&videoBuffer) == S_OK && videoBuffer)
    {
      videoBuffer->StartAccess(bmdBufferAccessWrite);
      void* frameBytes = nullptr;
      if (videoBuffer->GetBytes(&frameBytes) == S_OK && frameBytes)
      {
        bool copied = false;
        {
          std::lock_guard<std::mutex> lock(context->frameMutex);
          if (!context->frame.empty())
          {
            std::memcpy(frameBytes, context->frame.data(), context->frame.size());
            copied = true;
          }
        }

        if (!copied)
        {
          if (context->pixelFormat == bmdFormat8BitYUV)
          {
            FillBlackFrameYUV(static_cast<uint8_t*>(frameBytes), static_cast<size_t>(rowBytes) * static_cast<size_t>(context->height));
          }
          else
          {
            FillBlackFrame(static_cast<uint8_t*>(frameBytes), static_cast<size_t>(rowBytes) * static_cast<size_t>(context->height));
          }
        }
      }
      videoBuffer->EndAccess(bmdBufferAccessWrite);
      videoBuffer->Release();
    }

    context->output->DisplayVideoFrameSync(frame);
    frame->Release();
    std::this_thread::sleep_for(frameDuration);
  }
}

bool StopOutputInternal(int deviceIndex)
{
  std::shared_ptr<OutputContext> context;
  {
    std::lock_guard<std::mutex> lock(gOutputsMutex);
    auto it = gOutputs.find(deviceIndex);
    if (it == gOutputs.end())
    {
      return false;
    }
    context = it->second;
    gOutputs.erase(it);
  }

  if (context)
  {
    context->running.store(false);
    if (context->thread.joinable())
    {
      context->thread.join();
    }
    if (context->output)
    {
      context->output->DisableVideoOutput();
      context->output->Release();
      context->output = nullptr;
    }
    if (context->device)
    {
      context->device->Release();
      context->device = nullptr;
    }
  }

  return true;
}

Napi::Object StartOutput(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString())
  {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Expected device index and mode string."));
    return result;
  }

  const int deviceIndex = info[0].As<Napi::Number>().Int32Value();
  const std::string modeString = info[1].As<Napi::String>().Utf8Value();

  BMDDisplayMode displayMode = bmdModeHD1080p5994;
  int width = 1920;
  int height = 1080;
  double fps = 59.94;

  if (!ResolveMode(modeString, displayMode, width, height, fps))
  {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Unsupported video mode."));
    return result;
  }

  {
    std::lock_guard<std::mutex> lock(gOutputsMutex);
    auto it = gOutputs.find(deviceIndex);
    if (it != gOutputs.end())
    {
      if (it->second && it->second->mode == displayMode && it->second->running.load())
      {
        result.Set("ok", Napi::Boolean::New(env, true));
        result.Set("width", Napi::Number::New(env, it->second->width));
        result.Set("height", Napi::Number::New(env, it->second->height));
        result.Set("fps", Napi::Number::New(env, it->second->fps));
        return result;
      }
    }
  }

  StopOutputInternal(deviceIndex);

  CreateIteratorFunc createIterator = GetCreateIteratorFunc();
  if (!createIterator)
  {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "DeckLink API not available."));
    return result;
  }

  IDeckLinkIterator* iterator = createIterator();
  if (!iterator)
  {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Failed to create DeckLink iterator."));
    return result;
  }

  IDeckLink* deckLink = nullptr;
  IDeckLink* selectedDevice = nullptr;
  int currentIndex = 0;

  while (iterator->Next(&deckLink) == S_OK && deckLink)
  {
    if (currentIndex == deviceIndex)
    {
      selectedDevice = deckLink;
      break;
    }
    deckLink->Release();
    deckLink = nullptr;
    currentIndex++;
  }

  iterator->Release();

  if (!selectedDevice)
  {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "DeckLink device not found."));
    return result;
  }

  IDeckLinkOutput* output = nullptr;
  if (selectedDevice->QueryInterface(IID_IDeckLinkOutput, (void**)&output) != S_OK || !output)
  {
    selectedDevice->Release();
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Selected device does not support output."));
    return result;
  }

  bool supported = false;
  BMDDisplayMode actualMode = displayMode;
  if (output->DoesSupportVideoMode(bmdVideoConnectionUnspecified, displayMode, bmdFormat8BitYUV, bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actualMode, &supported) != S_OK || !supported)
  {
    supported = false;
    actualMode = displayMode;
    if (output->DoesSupportVideoMode(bmdVideoConnectionSDI, displayMode, bmdFormat8BitYUV, bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actualMode, &supported) != S_OK || !supported)
    {
      if (!FindFirstSupportedMode(output, actualMode, width, height, fps))
      {
        output->Release();
        selectedDevice->Release();
        result.Set("ok", Napi::Boolean::New(env, false));
        result.Set("error", Napi::String::New(env, "Requested mode not supported by device."));
        return result;
      }
    }
  }

  if (!GetDisplayModeDetails(output, actualMode, width, height, fps))
  {
    // Keep resolved defaults if lookup fails
  }

  if (output->EnableVideoOutput(actualMode, bmdVideoOutputFlagDefault) != S_OK)
  {
    output->Release();
    selectedDevice->Release();
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Failed to enable video output."));
    return result;
  }

  auto context = std::make_shared<OutputContext>();
  context->device = selectedDevice;
  context->output = output;
  context->mode = actualMode;
  context->pixelFormat = bmdFormat8BitYUV;
  context->width = width;
  context->height = height;
  context->bytesPerPixel = 2;
  context->fps = fps;
  context->running.store(true);
  context->thread = std::thread(OutputThread, context);

  {
    std::lock_guard<std::mutex> lock(gOutputsMutex);
    gOutputs[deviceIndex] = context;
  }

  const std::string actualModeLabel = ModeToString(actualMode);
  result.Set("ok", Napi::Boolean::New(env, true));
  result.Set("width", Napi::Number::New(env, width));
  result.Set("height", Napi::Number::New(env, height));
  result.Set("fps", Napi::Number::New(env, fps));
  if (!actualModeLabel.empty())
  {
    result.Set("mode", Napi::String::New(env, actualModeLabel));
  }
  return result;
}

Napi::Object StopOutput(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (info.Length() < 1 || !info[0].IsNumber())
  {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Expected device index."));
    return result;
  }

  const int deviceIndex = info[0].As<Napi::Number>().Int32Value();
  const bool stopped = StopOutputInternal(deviceIndex);
  result.Set("ok", Napi::Boolean::New(env, stopped));
  return result;
}

Napi::Object SendFrame(const Napi::CallbackInfo& info)
{
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsBuffer() || !info[2].IsNumber() || !info[3].IsNumber())
  {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Expected device index, buffer, width, height."));
    return result;
  }

  const int deviceIndex = info[0].As<Napi::Number>().Int32Value();
  auto buffer = info[1].As<Napi::Buffer<uint8_t>>();
  const int width = info[2].As<Napi::Number>().Int32Value();
  const int height = info[3].As<Napi::Number>().Int32Value();

  std::shared_ptr<OutputContext> context;
  {
    std::lock_guard<std::mutex> lock(gOutputsMutex);
    auto it = gOutputs.find(deviceIndex);
    if (it == gOutputs.end())
    {
      result.Set("ok", Napi::Boolean::New(env, false));
      result.Set("error", Napi::String::New(env, "Output not started."));
      return result;
    }
    context = it->second;
  }

  if (!context)
  {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Output context missing."));
    return result;
  }

  const size_t expectedSize = static_cast<size_t>(context->width) * static_cast<size_t>(context->height) * static_cast<size_t>(context->bytesPerPixel);
  if (width != context->width || height != context->height || buffer.Length() != expectedSize)
  {
    result.Set("ok", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Frame size does not match output mode."));
    result.Set("expectedWidth", Napi::Number::New(env, context->width));
    result.Set("expectedHeight", Napi::Number::New(env, context->height));
    result.Set("expectedSize", Napi::Number::New(env, static_cast<double>(expectedSize)));
    result.Set("actualWidth", Napi::Number::New(env, width));
    result.Set("actualHeight", Napi::Number::New(env, height));
    result.Set("actualSize", Napi::Number::New(env, static_cast<double>(buffer.Length())));
    return result;
  }

  {
    std::lock_guard<std::mutex> lock(context->frameMutex);
    context->frame.assign(buffer.Data(), buffer.Data() + buffer.Length());
  }

  result.Set("ok", Napi::Boolean::New(env, true));
  return result;
}
}

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("getDiagnostics", Napi::Function::New(env, GetDiagnostics));
  exports.Set("startOutput", Napi::Function::New(env, StartOutput));
  exports.Set("stopOutput", Napi::Function::New(env, StopOutput));
  exports.Set("sendFrame", Napi::Function::New(env, SendFrame));
  return exports;
}

NODE_API_MODULE(decklink_addon, Init)
