// Fixed reusable 20 ms blocks; Web Audio resamples the input to the context's 16 kHz.
class VoicePCM extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(320); this.used = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      this.block[this.used++] = value;
      if (this.used === 320) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(320); this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-pcm', VoicePCM);
