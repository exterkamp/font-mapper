// Projective (4-point) homography: solve for the 3x3 matrix mapping one
// quadrilateral onto another, and apply it to points. Used to dewarp a
// photographed/scanned template page back to the canonical flat layout.
(function (root) {
  function gaussianSolve(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      [M[col], M[pivot]] = [M[pivot], M[col]];
      const pv = M[col][col];
      if (Math.abs(pv) < 1e-12) throw new Error("Homography: singular system (degenerate points)");
      for (let c = col; c <= n; c++) M[col][c] /= pv;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row) => row[n]);
  }

  // from/to: arrays of 4 {x,y}. Returns 9-element row-major matrix (h33 = 1)
  // such that applyHomography(H, from[i]) ~= to[i].
  function solveHomography(from, to) {
    if (from.length !== 4 || to.length !== 4) {
      throw new Error("Homography needs exactly 4 point correspondences");
    }
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const { x: xs, y: ys } = from[i];
      const { x: xd, y: yd } = to[i];
      A.push([xs, ys, 1, 0, 0, 0, -xd * xs, -xd * ys]);
      b.push(xd);
      A.push([0, 0, 0, xs, ys, 1, -yd * xs, -yd * ys]);
      b.push(yd);
    }
    const h = gaussianSolve(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function applyHomography(H, x, y) {
    const d = H[6] * x + H[7] * y + H[8];
    return {
      x: (H[0] * x + H[1] * y + H[2]) / d,
      y: (H[3] * x + H[4] * y + H[5]) / d,
    };
  }

  const Homography = { solveHomography, applyHomography };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Homography;
  } else {
    root.Homography = Homography;
  }
})(typeof window !== "undefined" ? window : globalThis);
