// Microphone recording at full quality (no echo cancellation, noise suppression or auto gain,
// which smear pitch). Samples are captured with their exact audio-clock time so the
// recording can be lined up with the beat.
import { getCtx } from "./engine.js";

const WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor(){ super(); this.buf=[]; this.n=0; this.first=-1; this.on=true;
    this.port.onmessage=e=>{ if(e.data==='stop'){ this.flush(); this.port.postMessage({done:true}); this.on=false; } }; }
  flush(){ if(!this.n) return; const chs=this.buf[0].length; const out=[];
    for(let c=0;c<chs;c++){ const a=new Float32Array(this.n); let o=0; for(const b of this.buf){ a.set(b[c],o); o+=b[c].length; } out.push(a); }
    this.port.postMessage({chunk:out, first:this.first}, out.map(a=>a.buffer)); this.buf=[]; this.n=0; this.first=-1; }
  process(inputs){ if(!this.on) return false; const inp=inputs[0]; if(inp && inp.length){
      if(this.first<0) this.first=currentFrame;
      this.buf.push(inp.map(ch=>ch.slice())); this.n+=inp[0].length;
      let pk=0; const d=inp[0]; for(let i=0;i<d.length;i++){ const v=Math.abs(d[i]); if(v>pk) pk=v; }
      this.peak=Math.max(this.peak||0,pk);
      if(this.n>=4096){ this.flush(); this.port.postMessage({peak:this.peak}); this.peak=0; } }
    return true; }
}
registerProcessor('hs-capture', Cap);`;

let workletReady = null, stream = null;

export async function openMic() {
  const c = getCtx();
  if (!workletReady) workletReady = c.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
  await workletReady;
  if (!stream || stream.getTracks().some(t => t.readyState === "ended")) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } },
    });
  }
  return stream;
}
export function closeMic() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }

export class Recorder {
  async start(onLevel) {
    const c = getCtx(); const st = await openMic();
    this.src = c.createMediaStreamSource(st);
    this.node = new AudioWorkletNode(c, "hs-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: "explicit", channelCount: 2 });
    this.mute = c.createGain(); this.mute.gain.value = 0;
    this.src.connect(this.node); this.node.connect(this.mute); this.mute.connect(c.destination);
    this.chunks = []; this.firstFrame = -1;
    const settings = st.getAudioTracks()[0].getSettings ? st.getAudioTracks()[0].getSettings() : {};
    this.inputLatency = typeof settings.latency === "number" ? settings.latency : 0.01;
    this.done = new Promise(res => {
      this.node.port.onmessage = e => {
        const m = e.data;
        if (m.chunk) { if (this.firstFrame < 0) this.firstFrame = m.first; this.chunks.push(m.chunk); }
        if (m.peak != null && onLevel) onLevel(m.peak);
        if (m.done) res();
      };
    });
  }
  async stop() {
    this.node.port.postMessage("stop");
    await Promise.race([this.done, new Promise(r => setTimeout(r, 800))]);
    try { this.src.disconnect(); this.node.disconnect(); this.mute.disconnect(); } catch (e) { }
    const c = getCtx(), sr = c.sampleRate;
    const chs = this.chunks.length ? this.chunks[0].length : 1;
    const total = this.chunks.reduce((a, ch) => a + ch[0].length, 0);
    const out = []; for (let k = 0; k < chs; k++) { const a = new Float32Array(total); let o = 0; for (const ch of this.chunks) { a.set(ch[k], o); o += ch[k].length; } out.push(a); }
    // If the second channel is silent (mono mic reported as stereo), keep one channel.
    if (out.length > 1) { let e = 0; for (let i = 0; i < out[1].length; i += 50) e += Math.abs(out[1][i]); if (e < 1e-4) out.length = 1; }
    const startTime = this.firstFrame / sr;
    const outLat = (c.outputLatency || 0) + (c.baseLatency || 0);
    return { channels: out, sampleRate: sr, startTime, latency: outLat + this.inputLatency };
  }
}

// 24-bit WAV (lossless) for storing recordings.
export function encodeWav(channels, sr, bits = 24) {
  const ch = channels.length, n = channels[0].length, bps = bits / 8;
  const fmtFloat = bits === 32;
  const ab = new ArrayBuffer(44 + n * ch * bps), v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * ch * bps, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true);
  v.setUint16(20, fmtFloat ? 3 : 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * ch * bps, true);
  v.setUint16(32, ch * bps, true); v.setUint16(34, bits, true); w(36, "data"); v.setUint32(40, n * ch * bps, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let k = 0; k < ch; k++) {
    let s = channels[k][i]; s = Math.max(-1, Math.min(1, s));
    if (bits === 16) { v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    else if (bits === 24) { let x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; }
    else { v.setFloat32(o, s, true); o += 4; }
  }
  return new Blob([ab], { type: "audio/wav" });
}
