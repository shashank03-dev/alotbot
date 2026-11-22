// The loopback at the heart of the Alotbot Mic audio device: what Alotbot plays into the device's output comes back
// out of its input, as a microphone other apps can choose. Plain C, so the driver (which runs inside coreaudiod) and
// the tests share it.
#ifndef ALOTBOT_MIC_LOOP_H
#define ALOTBOT_MIC_LOOP_H

#include <stdint.h>

/// Frames the ring holds: about a third of a second at 48 kHz. Also the device's zero time stamp period.
#define ALOTBOT_MIC_RING_FRAMES 16384u
#define ALOTBOT_MIC_CHANNELS 2u

typedef struct {
    float samples[ALOTBOT_MIC_RING_FRAMES * ALOTBOT_MIC_CHANNELS];
} AlotbotMicLoop;

/// All silence.
void AlotbotMicLoopReset(AlotbotMicLoop *loop);

/// Output side: `frames` interleaved frames played at device sample time `sampleTime`.
void AlotbotMicLoopWrite(AlotbotMicLoop *loop, double sampleTime, uint32_t frames, const float *data);

/// Input side: the `frames` interleaved frames at `sampleTime`, then those slots go silent, so audio is heard once and
/// a stopped writer leaves silence, not a repeating third of a second.
void AlotbotMicLoopRead(AlotbotMicLoop *loop, double sampleTime, uint32_t frames, float *out);

#endif
