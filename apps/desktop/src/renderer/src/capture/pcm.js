class PlaybackPCM extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(4800)
    this.used = 0
    this.waiting = false
    this.port.onmessage = () => { this.waiting = false }
  }

  process(inputs) {
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let i = 0; i < channels[0].length; i++) {
      if (!this.used) this.startFrame = currentFrame + i
      for (let channel = 0; channel < 2; channel++) {
        this.block[this.used++] = (channels[channel] ?? channels[0])[i]
      }
      if (this.used === this.block.length) {
        if (!this.waiting) {
          this.waiting = true
          this.port.postMessage({ startFrame: this.startFrame, pcm: this.block.buffer }, [this.block.buffer])
          this.block = new Float32Array(4800)
        }
        this.used = 0
      }
    }
    return true
  }
}

registerProcessor('ojos-playback-pcm', PlaybackPCM)
