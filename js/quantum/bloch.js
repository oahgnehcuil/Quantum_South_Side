/* ==========================================================================
   bloch.js — where a qubit points on the Bloch sphere (a globe for one qubit).

   x = 2Re(conj(a)*b), y = 2Im(conj(a)*b), z = |a|^2 − |b|^2, where a and b are
   the amplitudes of |0⟩ and |1⟩. In a bigger register, a qubit that is
   entangled with others points INSIDE the globe: the arrow is shorter than 1.

   Example:
     import { blochVector, reducedBlochVector } from './bloch.js';
     blochVector(plusState);                 // {x: 1, y: 0, z: 0}
     reducedBlochVector(bellState, 0);       // {x: 0, y: 0, z: 0, purity: 0.5}
   ========================================================================== */

import { EPSILON, complex, conj, mul, add } from './complex.js';
import { assertState, checkQubit, bitsOf } from './state.js';

/** Turn numbers smaller than EPSILON into 0 so results never show noise or -0. */
function tidy(x) {
  return Math.abs(x) < EPSILON ? 0 : x;
}

/** The Bloch vector {x, y, z} of a one-qubit state. */
export function blochVector(state) {
  assertState(state);
  if (state.numQubits !== 1) throw new Error('blochVector works on one-qubit states. Use reducedBlochVector for a qubit of a bigger register.');
  const { purity, ...vector } = reducedBlochVector(state, 0);
  return vector;
}

/** The Bloch vector {x, y, z, purity} of one qubit of any register, found from its reduced density matrix (purity below 1 means entangled). */
export function reducedBlochVector(state, qubit) {
  assertState(state);
  checkQubit(qubit, state.numQubits);
  let p0 = 0; // chance the qubit is 0
  let p1 = 0; // chance the qubit is 1
  let coherence = complex(0, 0); // the sum of conj(amplitude with qubit=0) * (amplitude with qubit=1), over the other qubits
  state.amplitudes.forEach((amplitude, index) => {
    const bits = bitsOf(index, state.numQubits);
    if (bits[qubit] === 1) {
      const partnerBits = bits.map((b, q) => (q === qubit ? 0 : b));
      const partner = state.amplitudes[parseInt(partnerBits.join(''), 2)];
      coherence = add(coherence, mul(conj(partner), amplitude));
      p1 += amplitude.re ** 2 + amplitude.im ** 2;
    } else {
      p0 += amplitude.re ** 2 + amplitude.im ** 2;
    }
  });
  const x = 2 * coherence.re;
  const y = 2 * coherence.im;
  const z = p0 - p1;
  // Purity = trace of (density matrix squared) = (1 + x² + y² + z²) / 2 when the state has length 1.
  return { x: tidy(x), y: tidy(y), z: tidy(z), purity: (1 + x * x + y * y + z * z) / 2 };
}
