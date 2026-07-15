// Georeferencing transform solver: maps photo pixel coords <-> real-world UTM meters
// Tiered: 2 points -> similarity (scale+rotate+translate), 3 -> affine, 4+ -> projective homography (DLT, least squares)

const GeoTransform = (function () {
  // ---- generic linear algebra ----
  function solveLinearSystem(A, b) {
    // Gaussian elimination with partial pivoting. A: n x n, b: n. Returns x: n:
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      [M[col], M[pivot]] = [M[pivot], M[col]];
      if (Math.abs(M[col][col]) < 1e-12) throw new Error('Singular system - control points may be collinear or duplicated');
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col] / M[col][col];
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  function normalEquations(A, b) {
    // returns x minimizing ||Ax-b||^2 via (A^T A) x = A^T b
    const m = A.length, k = A[0].length;
    const AtA = Array.from({ length: k }, () => new Array(k).fill(0));
    const Atb = new Array(k).fill(0);
    for (let i = 0; i < m; i++) {
      for (let r = 0; r < k; r++) {
        Atb[r] += A[i][r] * b[i];
        for (let c = 0; c < k; c++) AtA[r][c] += A[i][r] * A[i][c];
      }
    }
    return solveLinearSystem(AtA, Atb);
  }

  function mat3Multiply(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++) C[i][j] += A[i][k] * B[k][j];
    return C;
  }

  function mat3Invert(M) {
    const [[a, b, c], [d, e, f], [g, h, i]] = M;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
    const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-15) throw new Error('Matrix not invertible');
    const invDet = 1 / det;
    return [
      [A * invDet, D * invDet, G * invDet],
      [B * invDet, E * invDet, H * invDet],
      [C * invDet, F * invDet, I * invDet],
    ];
  }

  function applyMat3(M, x, y) {
    const X = M[0][0] * x + M[0][1] * y + M[0][2];
    const Y = M[1][0] * x + M[1][1] * y + M[1][2];
    const W = M[2][0] * x + M[2][1] * y + M[2][2];
    return { x: X / W, y: Y / W };
  }

  function normalizePoints(pts) {
    const n = pts.length;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let meanDist = 0;
    for (const p of pts) meanDist += Math.hypot(p.x - mx, p.y - my);
    meanDist /= n;
    const scale = meanDist > 1e-9 ? Math.SQRT2 / meanDist : 1;
    const T = [
      [scale, 0, -scale * mx],
      [0, scale, -scale * my],
      [0, 0, 1],
    ];
    const normPts = pts.map((p) => applyMat3(T, p.x, p.y));
    return { normPts, T };
  }

  function fitSimilarity(src, dst) {
    // src, dst: [{x,y}], represent as complex numbers, solve dst = a*src + b (a: scale+rotation)
    const n = src.length;
    let msx = 0, msy = 0, mdx = 0, mdy = 0;
    for (let i = 0; i < n; i++) { msx += src[i].x; msy += src[i].y; mdx += dst[i].x; mdy += dst[i].y; }
    msx /= n; msy /= n; mdx /= n; mdy /= n;
    let numRe = 0, numIm = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const sx = src[i].x - msx, sy = src[i].y - msy;
      const dx = dst[i].x - mdx, dy = dst[i].y - mdy;
      // conj(s) * d  where s=sx+i sy, d=dx+i dy
      numRe += sx * dx + sy * dy;
      numIm += sx * dy - sy * dx;
      den += sx * sx + sy * sy;
    }
    const aRe = numRe / den, aIm = numIm / den;
    const bx = mdx - (aRe * msx - aIm * msy);
    const by = mdy - (aIm * msx + aRe * msy);
    // Build as 3x3 matrix: X = aRe*x - aIm*y + bx ; Y = aIm*x + aRe*y + by
    return [
      [aRe, -aIm, bx],
      [aIm, aRe, by],
      [0, 0, 1],
    ];
  }

  function fitAffine(src, dst) {
    const n = src.length;
    const Ax = src.map((p) => [p.x, p.y, 1]);
    const bX = dst.map((p) => p.x);
    const bY = dst.map((p) => p.y);
    const rowX = n === 3 ? solveLinearSystem(Ax, bX) : normalEquations(Ax, bX);
    const rowY = n === 3 ? solveLinearSystem(Ax, bY) : normalEquations(Ax, bY);
    return [
      [rowX[0], rowX[1], rowX[2]],
      [rowY[0], rowY[1], rowY[2]],
      [0, 0, 1],
    ];
  }

  function fitHomography(srcRaw, dstRaw) {
    const { normPts: src, T: Tsrc } = normalizePoints(srcRaw);
    const { normPts: dst, T: Tdst } = normalizePoints(dstRaw);
    const n = src.length;
    const A = [];
    const b = [];
    for (let i = 0; i < n; i++) {
      const { x, y } = src[i];
      const { x: X, y: Y } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
      b.push(X);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
      b.push(Y);
    }
    const h = n === 4 ? solveLinearSystem(A, b) : normalEquations(A, b);
    const Hnorm = [
      [h[0], h[1], h[2]],
      [h[3], h[4], h[5]],
      [h[6], h[7], 1],
    ];
    const TdstInv = mat3Invert(Tdst);
    const H = mat3Multiply(mat3Multiply(TdstInv, Hnorm), Tsrc);
    return H;
  }

  // controlPoints: [{px, py, e, n}] (pixel + UTM easting/northing, same zone/hemisphere)
  function computeTransform(controlPoints) {
    if (controlPoints.length < 2) throw new Error('Need at least 2 control points');
    const src = controlPoints.map((p) => ({ x: p.px, y: p.py }));
    const dst = controlPoints.map((p) => ({ x: p.e, y: p.n }));
    let method, H;
    if (controlPoints.length === 2) {
      method = 'similarity';
      H = fitSimilarity(src, dst);
    } else if (controlPoints.length === 3) {
      method = 'affine';
      H = fitAffine(src, dst);
    } else {
      method = 'homography';
      H = fitHomography(src, dst);
    }
    // residuals (in meters) at each control point, to report calibration accuracy
    const residuals = controlPoints.map((p) => {
      const r = applyMat3(H, p.px, p.py);
      return Math.hypot(r.x - p.e, r.y - p.n);
    });
    const Hinv = mat3Invert(H);
    return {
      method,
      pixelToUTM: (x, y) => applyMat3(H, x, y),
      utmToPixel: (e, n) => applyMat3(Hinv, e, n),
      residuals,
      maxResidual: Math.max(...residuals),
      rmsResidual: Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length),
    };
  }

  return { computeTransform, solveLinearSystem, normalEquations };
})();

if (typeof module !== 'undefined') module.exports = GeoTransform;
