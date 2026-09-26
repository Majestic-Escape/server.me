// Image quality metrics for the homepage hero's verified encodes
// (services/siteHeroImage.js) — the same measures the quality evidence uses:
// luma SSIM (8×8 windows, stride 4) mean and 1st percentile, and chroma
// PSNR (Cb/Cr, dB). All values are returned UNROUNDED: the bars are compared
// against exact numbers.

// RGB (or RGBA) raw → Y, Cb, Cr planes (BT.601, full range).
function planes(raw, channels) {
  const n = raw.length / channels;
  const Y = new Float32Array(n);
  const Cb = new Float32Array(n);
  const Cr = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i += 1, j += channels) {
    const r = raw[j];
    const g = raw[j + 1];
    const b = raw[j + 2];
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    Cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return { Y, Cb, Cr };
}

function ssim(a, b, w, h) {
  const C1 = 6.5025;
  const C2 = 58.5225;
  const vals = [];
  for (let y = 0; y + 8 <= h; y += 4) {
    for (let x = 0; x + 8 <= w; x += 4) {
      let ma = 0;
      let mb = 0;
      for (let d = 0; d < 8; d += 1) {
        const o = (y + d) * w + x;
        for (let e = 0; e < 8; e += 1) {
          ma += a[o + e];
          mb += b[o + e];
        }
      }
      ma /= 64;
      mb /= 64;
      let va = 0;
      let vb = 0;
      let c = 0;
      for (let d = 0; d < 8; d += 1) {
        const o = (y + d) * w + x;
        for (let e = 0; e < 8; e += 1) {
          const p = a[o + e] - ma;
          const q = b[o + e] - mb;
          va += p * p;
          vb += q * q;
          c += p * q;
        }
      }
      va /= 63;
      vb /= 63;
      c /= 63;
      vals.push(((2 * ma * mb + C1) * (2 * c + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)));
    }
  }
  if (!vals.length) return { mean: 1, p1: 1 };
  vals.sort((p, q) => p - q);
  return { mean: vals.reduce((s, v) => s + v, 0) / vals.length, p1: vals[Math.floor(vals.length * 0.01)] };
}

function psnr(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    m += d * d;
  }
  m /= a.length;
  return m === 0 ? 99 : 10 * Math.log10((255 * 255) / m);
}

// Metrics of `got` against `ref` (both raw RGB of the same w×h).
function compare(refPlanes, gotRaw, channels, w, h) {
  const got = planes(gotRaw, channels);
  const s = ssim(refPlanes.Y, got.Y, w, h);
  return { ssim: s.mean, p1: s.p1, chroma: (psnr(refPlanes.Cb, got.Cb) + psnr(refPlanes.Cr, got.Cr)) / 2 };
}

module.exports = { planes, ssim, psnr, compare };
