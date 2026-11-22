// Alotbot Mic: a virtual audio device for meetings. Alotbot plays your mic into the device's output, and meeting apps
// use its input as their microphone. While you hold the talk key Alotbot plays silence, so the meeting does not hear
// what you say to the bots. An Audio Server plug-in (runs inside coreaudiod), written against Apple's documented
// AudioServerPlugIn.h: one device, one input stream and one output stream, joined by a loopback ring.

#include <CoreAudio/AudioServerPlugIn.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <stdatomic.h>
#include <string.h>
#include "AlotbotMicLoop.h"

#pragma mark Objects and constants

enum {
    kObjectPlugIn = kAudioObjectPlugInObject,
    kObjectDevice = 2,
    kObjectInput = 3,
    kObjectOutput = 4,
};

#define kDeviceUID "AlotbotMic_UID"
#define kModelUID "AlotbotMic_Model"
#define kLatencyFrames 0
#define kSafetyFrames 64

static const Float64 kRates[] = { 44100.0, 48000.0 };
#define kRateCount (sizeof(kRates) / sizeof(kRates[0]))

static AudioServerPlugInHostRef gHost = NULL;
static pthread_mutex_t gLock = PTHREAD_MUTEX_INITIALIZER;
static Float64 gRate = 48000.0;
static UInt64 gIOCount = 0;          // clients running IO
static Float64 gHostTicksPerFrame = 0;
static UInt64 gAnchorHostTime = 0;
static UInt64 gTimestampCount = 0;
static AlotbotMicLoop gLoop;

#pragma mark Formats

static AudioStreamBasicDescription formatAt(Float64 rate) {
    AudioStreamBasicDescription f = {0};
    f.mSampleRate = rate;
    f.mFormatID = kAudioFormatLinearPCM;
    f.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagsNativeEndian | kAudioFormatFlagIsPacked;
    f.mBytesPerPacket = 4 * ALOTBOT_MIC_CHANNELS;
    f.mFramesPerPacket = 1;
    f.mBytesPerFrame = 4 * ALOTBOT_MIC_CHANNELS;
    f.mChannelsPerFrame = ALOTBOT_MIC_CHANNELS;
    f.mBitsPerChannel = 32;
    return f;
}

static void updateTicksPerFrame(void) {
    mach_timebase_info_data_t tb;
    mach_timebase_info(&tb);
    Float64 ticksPerSecond = 1e9 * (Float64)tb.denom / (Float64)tb.numer;
    gHostTicksPerFrame = ticksPerSecond / gRate;
}

#pragma mark Helpers for property data

#define NEED(size) do { if (inDataSize < (size)) return kAudioHardwareBadPropertySizeError; } while (0)
#define PUT(type, value) do { NEED(sizeof(type)); *(type *)outData = (value); *outDataSize = sizeof(type); return noErr; } while (0)
#define PUT_STRING(text) do { NEED(sizeof(CFStringRef)); *(CFStringRef *)outData = CFSTR(text); *outDataSize = sizeof(CFStringRef); return noErr; } while (0)

static UInt32 putIDs(const AudioObjectID *ids, UInt32 count, UInt32 inDataSize, UInt32 *outDataSize, void *outData) {
    UInt32 n = inDataSize / sizeof(AudioObjectID);
    if (n > count) n = count;
    memcpy(outData, ids, n * sizeof(AudioObjectID));
    *outDataSize = n * sizeof(AudioObjectID);
    return noErr;
}

static int isStream(AudioObjectID id) { return id == kObjectInput || id == kObjectOutput; }

#pragma mark Interface functions (declared, then the table)

static HRESULT AM_QueryInterface(void *inDriver, REFIID inUUID, LPVOID *outInterface);
static ULONG AM_AddRef(void *inDriver);
static ULONG AM_Release(void *inDriver);
static OSStatus AM_Initialize(AudioServerPlugInDriverRef inDriver, AudioServerPlugInHostRef inHost);
static OSStatus AM_CreateDevice(AudioServerPlugInDriverRef inDriver, CFDictionaryRef inDescription, const AudioServerPlugInClientInfo *inClientInfo, AudioObjectID *outDeviceObjectID);
static OSStatus AM_DestroyDevice(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID);
static OSStatus AM_AddDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, const AudioServerPlugInClientInfo *inClientInfo);
static OSStatus AM_RemoveDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, const AudioServerPlugInClientInfo *inClientInfo);
static OSStatus AM_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt64 inChangeAction, void *inChangeInfo);
static OSStatus AM_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt64 inChangeAction, void *inChangeInfo);
static Boolean AM_HasProperty(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID, const AudioObjectPropertyAddress *inAddress);
static OSStatus AM_IsPropertySettable(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID, const AudioObjectPropertyAddress *inAddress, Boolean *outIsSettable);
static OSStatus AM_GetPropertyDataSize(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID, const AudioObjectPropertyAddress *inAddress, UInt32 inQualifierDataSize, const void *inQualifierData, UInt32 *outDataSize);
static OSStatus AM_GetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID, const AudioObjectPropertyAddress *inAddress, UInt32 inQualifierDataSize, const void *inQualifierData, UInt32 inDataSize, UInt32 *outDataSize, void *outData);
static OSStatus AM_SetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID, const AudioObjectPropertyAddress *inAddress, UInt32 inQualifierDataSize, const void *inQualifierData, UInt32 inDataSize, const void *inData);
static OSStatus AM_StartIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID);
static OSStatus AM_StopIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID);
static OSStatus AM_GetZeroTimeStamp(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, Float64 *outSampleTime, UInt64 *outHostTime, UInt64 *outSeed);
static OSStatus AM_WillDoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, UInt32 inOperationID, Boolean *outWillDo, Boolean *outWillDoInPlace);
static OSStatus AM_BeginIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo *inIOCycleInfo);
static OSStatus AM_DoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, AudioObjectID inStreamObjectID, UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo *inIOCycleInfo, void *ioMainBuffer, void *ioSecondaryBuffer);
static OSStatus AM_EndIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo *inIOCycleInfo);

static AudioServerPlugInDriverInterface gInterface = {
    NULL,
    AM_QueryInterface, AM_AddRef, AM_Release,
    AM_Initialize, AM_CreateDevice, AM_DestroyDevice, AM_AddDeviceClient, AM_RemoveDeviceClient,
    AM_PerformDeviceConfigurationChange, AM_AbortDeviceConfigurationChange,
    AM_HasProperty, AM_IsPropertySettable, AM_GetPropertyDataSize, AM_GetPropertyData, AM_SetPropertyData,
    AM_StartIO, AM_StopIO, AM_GetZeroTimeStamp,
    AM_WillDoIOOperation, AM_BeginIOOperation, AM_DoIOOperation, AM_EndIOOperation,
};
static AudioServerPlugInDriverInterface *gInterfacePtr = &gInterface;
static AudioServerPlugInDriverRef gDriverRef = &gInterfacePtr;
static _Atomic UInt32 gRefCount = 0;

#pragma mark Factory and IUnknown

void *AlotbotMic_Create(CFAllocatorRef inAllocator, CFUUIDRef inRequestedTypeUUID) {
    (void)inAllocator;
    if (!CFEqual(inRequestedTypeUUID, kAudioServerPlugInTypeUUID)) return NULL;
    return gDriverRef;
}

static HRESULT AM_QueryInterface(void *inDriver, REFIID inUUID, LPVOID *outInterface) {
    if (inDriver != gDriverRef || outInterface == NULL) return kAudioHardwareBadObjectError;
    CFUUIDRef asked = CFUUIDCreateFromUUIDBytes(NULL, inUUID);
    HRESULT result = E_NOINTERFACE;
    if (CFEqual(asked, IUnknownUUID) || CFEqual(asked, kAudioServerPlugInDriverInterfaceUUID)) {
        atomic_fetch_add(&gRefCount, 1);
        *outInterface = gDriverRef;
        result = S_OK;
    }
    CFRelease(asked);
    return result;
}

static ULONG AM_AddRef(void *inDriver) {
    if (inDriver != gDriverRef) return 0;
    return atomic_fetch_add(&gRefCount, 1) + 1;
}

static ULONG AM_Release(void *inDriver) {
    if (inDriver != gDriverRef) return 0;
    UInt32 now = atomic_load(&gRefCount);
    if (now > 0) now = atomic_fetch_sub(&gRefCount, 1) - 1;
    return now;
}

#pragma mark Plug-in level

static OSStatus AM_Initialize(AudioServerPlugInDriverRef inDriver, AudioServerPlugInHostRef inHost) {
    if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
    gHost = inHost;
    updateTicksPerFrame();
    AlotbotMicLoopReset(&gLoop);
    return noErr;
}

static OSStatus AM_CreateDevice(AudioServerPlugInDriverRef d, CFDictionaryRef desc, const AudioServerPlugInClientInfo *c, AudioObjectID *out) {
    (void)d; (void)desc; (void)c; (void)out;
    return kAudioHardwareUnsupportedOperationError;
}

static OSStatus AM_DestroyDevice(AudioServerPlugInDriverRef d, AudioObjectID id) {
    (void)d; (void)id;
    return kAudioHardwareUnsupportedOperationError;
}

static OSStatus AM_AddDeviceClient(AudioServerPlugInDriverRef d, AudioObjectID id, const AudioServerPlugInClientInfo *c) {
    (void)c;
    return d == gDriverRef && id == kObjectDevice ? noErr : kAudioHardwareBadObjectError;
}

static OSStatus AM_RemoveDeviceClient(AudioServerPlugInDriverRef d, AudioObjectID id, const AudioServerPlugInClientInfo *c) {
    (void)c;
    return d == gDriverRef && id == kObjectDevice ? noErr : kAudioHardwareBadObjectError;
}

/// A rate change asked for in SetPropertyData is applied here, when the host says it is safe.
static OSStatus AM_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef d, AudioObjectID id, UInt64 action, void *info) {
    (void)info;
    if (d != gDriverRef || id != kObjectDevice) return kAudioHardwareBadObjectError;
    if (action >= kRateCount) return kAudioHardwareBadObjectError;
    pthread_mutex_lock(&gLock);
    gRate = kRates[action];
    updateTicksPerFrame();
    AlotbotMicLoopReset(&gLoop);
    pthread_mutex_unlock(&gLock);
    return noErr;
}

static OSStatus AM_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef d, AudioObjectID id, UInt64 action, void *info) {
    (void)action; (void)info;
    return d == gDriverRef && id == kObjectDevice ? noErr : kAudioHardwareBadObjectError;
}

#pragma mark Properties

static Boolean AM_HasProperty(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress *a) {
    UInt32 size = 0;
    return d == gDriverRef && AM_GetPropertyDataSize(d, id, pid, a, 0, NULL, &size) == noErr;
}

static OSStatus AM_IsPropertySettable(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress *a, Boolean *out) {
    if (!AM_HasProperty(d, id, pid, a)) return kAudioHardwareUnknownPropertyError;
    *out = (id == kObjectDevice && a->mSelector == kAudioDevicePropertyNominalSampleRate)
        || (isStream(id) && (a->mSelector == kAudioStreamPropertyVirtualFormat || a->mSelector == kAudioStreamPropertyPhysicalFormat));
    return noErr;
}

static OSStatus AM_GetPropertyDataSize(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress *a, UInt32 qs, const void *q, UInt32 *out) {
    // Every property's size is what GetPropertyData writes when given room for everything.
    union { AudioStreamRangedDescription formats[kRateCount]; AudioValueRange ranges[kRateCount]; AudioObjectID ids[4]; UInt8 bytes[256]; } scratch;
    return AM_GetPropertyData(d, id, pid, a, qs, q, sizeof(scratch), out, &scratch);
}

static OSStatus plugInProperty(const AudioObjectPropertyAddress *a, UInt32 qs, const void *q, UInt32 inDataSize, UInt32 *outDataSize, void *outData) {
    static const AudioObjectID devices[] = { kObjectDevice };
    switch (a->mSelector) {
    case kAudioObjectPropertyBaseClass: PUT(AudioClassID, kAudioObjectClassID);
    case kAudioObjectPropertyClass: PUT(AudioClassID, kAudioPlugInClassID);
    case kAudioObjectPropertyOwner: PUT(AudioObjectID, kAudioObjectUnknown);
    case kAudioObjectPropertyManufacturer: PUT_STRING("Alotbot");
    case kAudioObjectPropertyOwnedObjects:
    case kAudioPlugInPropertyDeviceList:
        return putIDs(devices, 1, inDataSize, outDataSize, outData);
    case kAudioPlugInPropertyTranslateUIDToDevice: {
        NEED(sizeof(AudioObjectID));
        if (qs != sizeof(CFStringRef) || q == NULL) return kAudioHardwareBadPropertySizeError;
        Boolean ours = CFStringCompare(*(const CFStringRef *)q, CFSTR(kDeviceUID), 0) == kCFCompareEqualTo;
        *(AudioObjectID *)outData = ours ? kObjectDevice : kAudioObjectUnknown;
        *outDataSize = sizeof(AudioObjectID);
        return noErr;
    }
    case kAudioPlugInPropertyResourceBundle: PUT_STRING("");
    default: return kAudioHardwareUnknownPropertyError;
    }
}

static OSStatus deviceProperty(const AudioObjectPropertyAddress *a, UInt32 inDataSize, UInt32 *outDataSize, void *outData) {
    const AudioObjectPropertyScope scope = a->mScope;
    switch (a->mSelector) {
    case kAudioObjectPropertyBaseClass: PUT(AudioClassID, kAudioObjectClassID);
    case kAudioObjectPropertyClass: PUT(AudioClassID, kAudioDeviceClassID);
    case kAudioObjectPropertyOwner: PUT(AudioObjectID, kObjectPlugIn);
    case kAudioObjectPropertyName: PUT_STRING("Alotbot Mic");
    case kAudioObjectPropertyManufacturer: PUT_STRING("Alotbot");
    case kAudioObjectPropertyOwnedObjects:
    case kAudioDevicePropertyStreams: {
        AudioObjectID both[] = { kObjectInput, kObjectOutput };
        if (scope == kAudioObjectPropertyScopeInput) return putIDs(&both[0], 1, inDataSize, outDataSize, outData);
        if (scope == kAudioObjectPropertyScopeOutput) return putIDs(&both[1], 1, inDataSize, outDataSize, outData);
        return putIDs(both, 2, inDataSize, outDataSize, outData);
    }
    case kAudioObjectPropertyControlList: *outDataSize = 0; return noErr;
    case kAudioDevicePropertyDeviceUID: PUT_STRING(kDeviceUID);
    case kAudioDevicePropertyModelUID: PUT_STRING(kModelUID);
    case kAudioDevicePropertyTransportType: PUT(UInt32, kAudioDeviceTransportTypeVirtual);
    case kAudioDevicePropertyRelatedDevices: {
        AudioObjectID self = kObjectDevice;
        return putIDs(&self, 1, inDataSize, outDataSize, outData);
    }
    case kAudioDevicePropertyClockDomain: PUT(UInt32, 0);
    case kAudioDevicePropertyDeviceIsAlive: PUT(UInt32, 1);
    case kAudioDevicePropertyDeviceIsRunning: PUT(UInt32, gIOCount > 0);
    // It is a microphone: an app may make it its default input, never its default output or the system sound.
    case kAudioDevicePropertyDeviceCanBeDefaultDevice: PUT(UInt32, scope == kAudioObjectPropertyScopeInput);
    case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice: PUT(UInt32, 0);
    case kAudioDevicePropertyLatency: PUT(UInt32, kLatencyFrames);
    case kAudioDevicePropertySafetyOffset: PUT(UInt32, kSafetyFrames);
    case kAudioDevicePropertyNominalSampleRate: PUT(Float64, gRate);
    case kAudioDevicePropertyAvailableNominalSampleRates: {
        UInt32 n = inDataSize / sizeof(AudioValueRange);
        if (n > kRateCount) n = kRateCount;
        for (UInt32 i = 0; i < n; i++) ((AudioValueRange *)outData)[i] = (AudioValueRange){ kRates[i], kRates[i] };
        *outDataSize = n * sizeof(AudioValueRange);
        return noErr;
    }
    case kAudioDevicePropertyIsHidden: PUT(UInt32, 0);
    case kAudioDevicePropertyZeroTimeStampPeriod: PUT(UInt32, ALOTBOT_MIC_RING_FRAMES);
    case kAudioDevicePropertyClockIsStable: PUT(UInt32, 1);
    case kAudioDevicePropertyPreferredChannelsForStereo: {
        NEED(2 * sizeof(UInt32));
        ((UInt32 *)outData)[0] = 1;
        ((UInt32 *)outData)[1] = 2;
        *outDataSize = 2 * sizeof(UInt32);
        return noErr;
    }
    default: return kAudioHardwareUnknownPropertyError;
    }
}

static OSStatus streamProperty(AudioObjectID id, const AudioObjectPropertyAddress *a, UInt32 inDataSize, UInt32 *outDataSize, void *outData) {
    switch (a->mSelector) {
    case kAudioObjectPropertyBaseClass: PUT(AudioClassID, kAudioObjectClassID);
    case kAudioObjectPropertyClass: PUT(AudioClassID, kAudioStreamClassID);
    case kAudioObjectPropertyOwner: PUT(AudioObjectID, kObjectDevice);
    case kAudioObjectPropertyOwnedObjects: *outDataSize = 0; return noErr;
    case kAudioStreamPropertyIsActive: PUT(UInt32, 1);
    case kAudioStreamPropertyDirection: PUT(UInt32, id == kObjectInput ? 1 : 0);
    case kAudioStreamPropertyTerminalType: PUT(UInt32, id == kObjectInput ? kAudioStreamTerminalTypeMicrophone : kAudioStreamTerminalTypeSpeaker);
    case kAudioStreamPropertyStartingChannel: PUT(UInt32, 1);
    case kAudioStreamPropertyLatency: PUT(UInt32, kLatencyFrames);
    case kAudioStreamPropertyVirtualFormat:
    case kAudioStreamPropertyPhysicalFormat: PUT(AudioStreamBasicDescription, formatAt(gRate));
    case kAudioStreamPropertyAvailableVirtualFormats:
    case kAudioStreamPropertyAvailablePhysicalFormats: {
        UInt32 n = inDataSize / sizeof(AudioStreamRangedDescription);
        if (n > kRateCount) n = kRateCount;
        for (UInt32 i = 0; i < n; i++) {
            ((AudioStreamRangedDescription *)outData)[i] = (AudioStreamRangedDescription){ formatAt(kRates[i]), { kRates[i], kRates[i] } };
        }
        *outDataSize = n * sizeof(AudioStreamRangedDescription);
        return noErr;
    }
    default: return kAudioHardwareUnknownPropertyError;
    }
}

static OSStatus AM_GetPropertyData(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress *a, UInt32 qs, const void *q, UInt32 inDataSize, UInt32 *outDataSize, void *outData) {
    (void)pid;
    if (d != gDriverRef) return kAudioHardwareBadObjectError;
    if (a == NULL || outDataSize == NULL || outData == NULL) return kAudioHardwareIllegalOperationError;
    switch (id) {
    case kObjectPlugIn: return plugInProperty(a, qs, q, inDataSize, outDataSize, outData);
    case kObjectDevice: return deviceProperty(a, inDataSize, outDataSize, outData);
    case kObjectInput:
    case kObjectOutput: return streamProperty(id, a, inDataSize, outDataSize, outData);
    default: return kAudioHardwareBadObjectError;
    }
}

/// Asks the host to change the rate: it calls PerformDeviceConfigurationChange with the rate's index when it is safe.
static OSStatus requestRate(Float64 rate) {
    for (UInt64 i = 0; i < kRateCount; i++) {
        if (kRates[i] == rate) {
            if (rate != gRate) gHost->RequestDeviceConfigurationChange(gHost, kObjectDevice, i, NULL);
            return noErr;
        }
    }
    return kAudioDeviceUnsupportedFormatError;
}

static OSStatus AM_SetPropertyData(AudioServerPlugInDriverRef d, AudioObjectID id, pid_t pid, const AudioObjectPropertyAddress *a, UInt32 qs, const void *q, UInt32 inDataSize, const void *inData) {
    (void)pid; (void)qs; (void)q;
    if (d != gDriverRef) return kAudioHardwareBadObjectError;
    if (id == kObjectDevice && a->mSelector == kAudioDevicePropertyNominalSampleRate) {
        if (inDataSize != sizeof(Float64)) return kAudioHardwareBadPropertySizeError;
        return requestRate(*(const Float64 *)inData);
    }
    if (isStream(id) && (a->mSelector == kAudioStreamPropertyVirtualFormat || a->mSelector == kAudioStreamPropertyPhysicalFormat)) {
        if (inDataSize != sizeof(AudioStreamBasicDescription)) return kAudioHardwareBadPropertySizeError;
        const AudioStreamBasicDescription *f = inData;
        AudioStreamBasicDescription ours = formatAt(f->mSampleRate);
        if (f->mFormatID != ours.mFormatID || f->mFormatFlags != ours.mFormatFlags || f->mChannelsPerFrame != ours.mChannelsPerFrame || f->mBitsPerChannel != ours.mBitsPerChannel) {
            return kAudioDeviceUnsupportedFormatError;
        }
        return requestRate(f->mSampleRate);
    }
    return AM_HasProperty(d, id, pid, a) ? kAudioHardwareUnsupportedOperationError : kAudioHardwareUnknownPropertyError;
}

#pragma mark IO

static OSStatus AM_StartIO(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 client) {
    (void)client;
    if (d != gDriverRef || id != kObjectDevice) return kAudioHardwareBadObjectError;
    pthread_mutex_lock(&gLock);
    if (gIOCount++ == 0) {
        gTimestampCount = 0;
        gAnchorHostTime = mach_absolute_time();
        AlotbotMicLoopReset(&gLoop);
    }
    pthread_mutex_unlock(&gLock);
    return noErr;
}

static OSStatus AM_StopIO(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 client) {
    (void)client;
    if (d != gDriverRef || id != kObjectDevice) return kAudioHardwareBadObjectError;
    pthread_mutex_lock(&gLock);
    if (gIOCount > 0) gIOCount--;
    pthread_mutex_unlock(&gLock);
    return noErr;
}

/// The device clock: one period (the ring's length) passes every ALOTBOT_MIC_RING_FRAMES frames of host time.
static OSStatus AM_GetZeroTimeStamp(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 client, Float64 *outSampleTime, UInt64 *outHostTime, UInt64 *outSeed) {
    (void)client;
    if (d != gDriverRef || id != kObjectDevice) return kAudioHardwareBadObjectError;
    Float64 ticksPerPeriod = gHostTicksPerFrame * (Float64)ALOTBOT_MIC_RING_FRAMES;
    UInt64 now = mach_absolute_time();
    UInt64 next = gAnchorHostTime + (UInt64)((Float64)(gTimestampCount + 1) * ticksPerPeriod);
    if (next <= now) gTimestampCount++;
    *outSampleTime = (Float64)(gTimestampCount * ALOTBOT_MIC_RING_FRAMES);
    *outHostTime = gAnchorHostTime + (UInt64)((Float64)gTimestampCount * ticksPerPeriod);
    *outSeed = 1;
    return noErr;
}

static OSStatus AM_WillDoIOOperation(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 client, UInt32 op, Boolean *outWillDo, Boolean *outInPlace) {
    (void)client;
    if (d != gDriverRef || id != kObjectDevice) return kAudioHardwareBadObjectError;
    *outWillDo = op == kAudioServerPlugInIOOperationReadInput || op == kAudioServerPlugInIOOperationWriteMix;
    *outInPlace = true;
    return noErr;
}

static OSStatus AM_BeginIOOperation(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 client, UInt32 op, UInt32 frames, const AudioServerPlugInIOCycleInfo *info) {
    (void)client; (void)op; (void)frames; (void)info;
    return d == gDriverRef && id == kObjectDevice ? noErr : kAudioHardwareBadObjectError;
}

static OSStatus AM_DoIOOperation(AudioServerPlugInDriverRef d, AudioObjectID id, AudioObjectID stream, UInt32 client, UInt32 op, UInt32 frames, const AudioServerPlugInIOCycleInfo *info, void *main, void *secondary) {
    (void)client; (void)secondary;
    if (d != gDriverRef || id != kObjectDevice) return kAudioHardwareBadObjectError;
    if (main == NULL) return noErr;
    if (op == kAudioServerPlugInIOOperationWriteMix && stream == kObjectOutput) {
        AlotbotMicLoopWrite(&gLoop, info->mOutputTime.mSampleTime, frames, main);
    } else if (op == kAudioServerPlugInIOOperationReadInput && stream == kObjectInput) {
        AlotbotMicLoopRead(&gLoop, info->mInputTime.mSampleTime, frames, main);
    }
    return noErr;
}

static OSStatus AM_EndIOOperation(AudioServerPlugInDriverRef d, AudioObjectID id, UInt32 client, UInt32 op, UInt32 frames, const AudioServerPlugInIOCycleInfo *info) {
    (void)client; (void)op; (void)frames; (void)info;
    return d == gDriverRef && id == kObjectDevice ? noErr : kAudioHardwareBadObjectError;
}
