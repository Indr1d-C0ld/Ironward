# Isola il primo colpo di una registrazione: attacco, coda naturale, dissolvenza, normalizzazione.
import sys, subprocess, numpy as np, wave
src, dst, length = sys.argv[1], sys.argv[2], float(sys.argv[3])
SR = 32000
raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'], capture_output=True, check=True).stdout
x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768
peak = np.abs(x).max()
on = int(np.argmax(np.abs(x) > peak * 0.25))          # primo colpo
start = max(0, on - int(0.004 * SR))
seg = x[start:start + int(length * SR)].copy()
fade = int(len(seg) * 0.35)
seg[-fade:] *= np.linspace(1, 0, fade) ** 2              # coda che si spegne
seg[:int(0.002 * SR)] *= np.linspace(0, 1, int(0.002 * SR))
seg /= max(1e-6, np.abs(seg).max()) / 0.89               # picco a -1 dBFS
with wave.open(dst, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((seg * 32767).astype(np.int16).tobytes())
print(f'{dst.split("/")[-1]}: {len(seg)/SR:.2f} s, attacco a {on/SR:.2f} s')
