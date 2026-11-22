#include "AlotbotMicLoop.h"
#include <string.h>

void AlotbotMicLoopReset(AlotbotMicLoop *loop) {
    memset(loop->samples, 0, sizeof(loop->samples));
}

static uint32_t slot(double sampleTime) {
    // Sample times are whole frames counted from the device's start, always positive.
    return (uint32_t)((uint64_t)sampleTime % ALOTBOT_MIC_RING_FRAMES);
}

void AlotbotMicLoopWrite(AlotbotMicLoop *loop, double sampleTime, uint32_t frames, const float *data) {
    if (frames > ALOTBOT_MIC_RING_FRAMES) frames = ALOTBOT_MIC_RING_FRAMES;
    uint32_t at = slot(sampleTime);
    uint32_t first = ALOTBOT_MIC_RING_FRAMES - at < frames ? ALOTBOT_MIC_RING_FRAMES - at : frames;
    memcpy(&loop->samples[at * ALOTBOT_MIC_CHANNELS], data, first * ALOTBOT_MIC_CHANNELS * sizeof(float));
    memcpy(&loop->samples[0], data + first * ALOTBOT_MIC_CHANNELS, (frames - first) * ALOTBOT_MIC_CHANNELS * sizeof(float));
}

void AlotbotMicLoopRead(AlotbotMicLoop *loop, double sampleTime, uint32_t frames, float *out) {
    if (frames > ALOTBOT_MIC_RING_FRAMES) frames = ALOTBOT_MIC_RING_FRAMES;
    uint32_t at = slot(sampleTime);
    uint32_t first = ALOTBOT_MIC_RING_FRAMES - at < frames ? ALOTBOT_MIC_RING_FRAMES - at : frames;
    memcpy(out, &loop->samples[at * ALOTBOT_MIC_CHANNELS], first * ALOTBOT_MIC_CHANNELS * sizeof(float));
    memcpy(out + first * ALOTBOT_MIC_CHANNELS, &loop->samples[0], (frames - first) * ALOTBOT_MIC_CHANNELS * sizeof(float));
    memset(&loop->samples[at * ALOTBOT_MIC_CHANNELS], 0, first * ALOTBOT_MIC_CHANNELS * sizeof(float));
    memset(&loop->samples[0], 0, (frames - first) * ALOTBOT_MIC_CHANNELS * sizeof(float));
}
