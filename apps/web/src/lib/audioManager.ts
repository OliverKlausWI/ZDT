export class AudioManager {
  private ctx: AudioContext | null = null;
  private unlocked = false;

  private currentSource: AudioBufferSourceNode | null = null;
  private queue: ArrayBuffer[] = [];
  private playing = false;

  isUnlocked() {
    return this.unlocked;
  }

  async unlock(): Promise<void> {
    if (!this.ctx) {
      // @ts-ignore
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new AC();
    }

    if (this.ctx.state !== "running") {
      await this.ctx.resume();
    }

    // „Silent buffer“ abspielen, damit Safari/Autoplay wirklich freigibt
    const buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    source.start(0);

    this.unlocked = true;
  }

  stopAll(): void {
    this.queue = [];
    this.playing = false;

    try {
      this.currentSource?.stop();
    } catch {
      // ignore
    }
    this.currentSource = null;
  }

  enqueueWav(wav: ArrayBuffer): void {
    this.queue.push(wav);
    if (!this.playing) {
      void this.playNext();
    }
  }

  private async playNext(): Promise<void> {
    if (!this.ctx || !this.unlocked) return;
    const next = this.queue.shift();
    if (!next) return;

    this.playing = true;

    try {
      const audioBuffer = await this.decode(next);
      const source = this.ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.ctx.destination);

      this.currentSource = source;

      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start(0);
      });
    } catch {
      // Falls decode fehlschlägt: skip
    } finally {
      this.currentSource = null;
      this.playing = false;
      if (this.queue.length > 0) {
        void this.playNext();
      }
    }
  }

  private async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.ctx) throw new Error("AudioContext not initialized");
    // decodeAudioData kann Safari-zickig sein → defensive Kopie
    const copy = data.slice(0);
    return await this.ctx.decodeAudioData(copy);
  }
}