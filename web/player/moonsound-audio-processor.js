class MoonSoundProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.currentChunk = null;
    this.currentOffset = 0;
    this.playing = false;
    this.ending = false;
    this.pendingRequest = false;
    this.frameCounter = 0;
    this.queuedFrames = 0;
    this.fadeFrames = Math.floor(sampleRate * 0.75);

    this.port.postMessage({ type: 'ready' });

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'buffer') {
        this.queue.push({ left: msg.left, right: msg.right });
        this.queuedFrames += msg.left.length;
        this.pendingRequest = false;
      } else if (msg.type === 'start') {
        this.playing = true;
        this.ending = false;
      } else if (msg.type === 'pause') {
        this.playing = false;
      } else if (msg.type === 'stop') {
        this.playing = false;
        this.ending = false;
        this.queue = [];
        this.currentChunk = null;
        this.currentOffset = 0;
        this.queuedFrames = 0;
        this.pendingRequest = false;
      } else if (msg.type === 'end') {
        this.ending = true;
        if (!this.currentChunk && this.queue.length === 0) {
          this.playing = false;
          this.ending = false;
          this.queuedFrames = 0;
          this.port.postMessage({ type: 'drained' });
        }
      } else if (msg.type === 'ping') {
        this.port.postMessage({ type: 'pong', queueLength: this.queue.length, playing: this.playing });
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) {
      return true;
    }

    const outLeft = output[0];
    const outRight = output[1];
    const frameCount = outLeft.length;

    if (!this.playing) {
      outLeft.fill(0);
      outRight.fill(0);
      return true;
    }

    let written = 0;
    while (written < frameCount) {
      if (!this.currentChunk) {
        if (this.queue.length === 0) {
          outLeft.fill(0, written);
          outRight.fill(0, written);
          break;
        }
        this.currentChunk = this.queue.shift();
        this.currentOffset = 0;
      }

      const srcL = this.currentChunk.left;
      const srcR = this.currentChunk.right;
      const available = srcL.length - this.currentOffset;
      const needed = frameCount - written;
      const toCopy = Math.min(available, needed);

      for (let i = 0; i < toCopy; i += 1) {
        let gain = 1;
        if (this.ending && this.fadeFrames > 0 && this.queuedFrames < this.fadeFrames) {
          gain = this.queuedFrames / this.fadeFrames;
        }
        outLeft[written + i] = srcL[this.currentOffset + i] * gain;
        outRight[written + i] = srcR[this.currentOffset + i] * gain;
        if (this.queuedFrames > 0) this.queuedFrames -= 1;
      }

      written += toCopy;
      this.currentOffset += toCopy;

      if (this.currentOffset >= srcL.length) {
        this.currentChunk = null;
        this.currentOffset = 0;
      }
    }

    if (this.ending && this.queue.length === 0 && !this.currentChunk && this.queuedFrames === 0) {
      this.playing = false;
      this.ending = false;
      this.port.postMessage({ type: 'drained' });
    }

    if (!this.ending && this.queue.length < 6 && !this.pendingRequest) {
      this.pendingRequest = true;
      this.port.postMessage({ type: 'need-data' });
    }

    this.frameCounter += frameCount;
    if (this.frameCounter >= sampleRate) {
      this.frameCounter = 0;
      this.port.postMessage({ type: 'stats', queueLength: this.queue.length });
    }

    return true;
  }
}

registerProcessor('moonsound-processor', MoonSoundProcessor);
