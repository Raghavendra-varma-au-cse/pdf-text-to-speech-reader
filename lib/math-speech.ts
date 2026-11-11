/**
 * Convert mathematical notation into words that a speech engine can read
 * naturally, while leaving ordinary prose alone.
 *
 * This is deliberately heuristic: PDF text extraction gives us no reliable
 * "this is a formula" marker (and the same is true for most Markdown/DOCX
 * files), so we only expand operators when the surrounding text actually looks
 * mathematical. That keeps normal prose such as "state-of-the-art" or
 * "read/write" intact.
 */

const GREEK: Record<string, string> = {
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon',
  'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ι': 'iota', 'κ': 'kappa',
  'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron',
  'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'ς': 'sigma', 'τ': 'tau',
  'υ': 'upsilon', 'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  'Α': 'Alpha', 'Β': 'Beta', 'Γ': 'Gamma', 'Δ': 'Delta', 'Ε': 'Epsilon',
  'Ζ': 'Zeta', 'Η': 'Eta', 'Θ': 'Theta', 'Ι': 'Iota', 'Κ': 'Kappa',
  'Λ': 'Lambda', 'Μ': 'Mu', 'Ν': 'Nu', 'Ξ': 'Xi', 'Ο': 'Omicron',
  'Π': 'Pi', 'Ρ': 'Rho', 'Σ': 'Sigma', 'Τ': 'Tau', 'Υ': 'Upsilon',
  'Φ': 'Phi', 'Χ': 'Chi', 'Ψ': 'Psi', 'Ω': 'Omega',
};

const SYMBOLS: Record<string, string> = {
  '×': ' times ', '·': ' times ', '÷': ' divided by ', '±': ' plus or minus ',
  '∓': ' minus or plus ', '≤': ' less than or equal to ', '≥': ' greater than or equal to ',
  '≠': ' not equal to ', '≈': ' approximately equal to ', '≅': ' congruent to ',
  '≡': ' equivalent to ', '∞': ' infinity ', '∑': ' sum of ', '∏': ' product of ',
  '∫': ' integral of ', '√': ' square root of ', '∂': ' partial ', '∇': ' nabla ',
  '∈': ' in ', '∉': ' not in ', '⊂': ' subset of ', '⊆': ' subset of or equal to ',
  '∪': ' union ', '∩': ' intersection ', '→': ' tends to ', '⇒': ' implies ',
  '⇔': ' if and only if ', '∝': ' proportional to ', '∴': ' therefore ',
  '°': ' degrees ', '%': ' percent ', '′': ' prime ', '″': ' double prime ',
  '…': '...', '−': '-', '–': '-', '—': ' - ',
};

const SUPERSCRIPTS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5',
  '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-',
  '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i',
};

const SUBSCRIPT_DIGITS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5',
  '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-',
  '₌': '=', '₍': '(', '₎': ')', 'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h',
  'ᵢ': 'i', 'ⱼ': 'j', 'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n',
  'ₒ': 'o', 'ₚ': 'p', 'ᵣ': 'r', 'ₛ': 's', 'ₜ': 't', 'ᵤ': 'u',
  'ᵥ': 'v', 'ₓ': 'x',
};

const FRACTIONS: Record<string, string> = {
  '½': 'one half', '⅓': 'one third', '⅔': 'two thirds', '¼': 'one quarter',
  '¾': 'three quarters', '⅕': 'one fifth', '⅖': 'two fifths', '⅗': 'three fifths',
  '⅘': 'four fifths', '⅙': 'one sixth', '⅚': 'five sixths', '⅛': 'one eighth',
  '⅜': 'three eighths', '⅝': 'five eighths', '⅞': 'seven eighths',
};

const LATEX_GREEK =
  'alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|omicron|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega';

function replaceLatex(text: string): string {
  let out = text;

  // \text{...}, \mathrm{...}, \mathbf{...} keep their content.
  out = out.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, '$1');

  // Fractions: \frac{a}{b} -> "a over b". A few passes handle simple nesting.
  for (let i = 0; i < 3; i++) {
    const next = out.replace(
      /\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
      (_match, numerator: string, denominator: string) =>
        `${numerator.trim()} over ${denominator.trim()}`
    );
    if (next === out) break;
    out = next;
  }

  out = out.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, '$1 th root of $2');
  out = out.replace(/\\sqrt\s*\{([^{}]*)\}/g, ' square root of $1 ');
  out = out.replace(/\\frac\s*([A-Za-z0-9])\s*([A-Za-z0-9])/g, '$1 over $2');

  out = out
    .replace(/\\(?:cdot|times)/g, ' times ')
    .replace(/\\div/g, ' divided by ')
    .replace(/\\pm/g, ' plus or minus ')
    .replace(/\\mp/g, ' minus or plus ')
    .replace(/\\(?:leq|le)\b/g, ' less than or equal to ')
    .replace(/\\(?:geq|ge)\b/g, ' greater than or equal to ')
    .replace(/\\(?:neq|ne)\b/g, ' not equal to ')
    .replace(/\\approx/g, ' approximately equal to ')
    .replace(/\\infty/g, ' infinity ')
    .replace(/\\sum/g, ' sum of ')
    .replace(/\\prod/g, ' product of ')
    .replace(/\\int/g, ' integral of ')
    .replace(/\\partial/g, ' partial ')
    .replace(/\\nabla/g, ' nabla ')
    .replace(/\\to|\\rightarrow/g, ' tends to ')
    .replace(/\\Rightarrow/g, ' implies ')
    .replace(/\\Leftrightarrow/g, ' if and only if ')
    .replace(/\\in\b/g, ' in ')
    .replace(/\\pi\b/g, ' pi ')
    .replace(new RegExp(`\\\\(${LATEX_GREEK})\\b`, 'g'), '$1')
    .replace(/\\left|\\right|\\,|\\;|\\!|\\quad|\\qquad|\\displaystyle/g, ' ')
    .replace(/\\\\/g, ' ')
    .replace(/[{}$]/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' '); // unknown command: drop the backslash word

  return out;
}

function replaceUnicodePowers(text: string): string {
  let out = text.replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (fraction) => ` ${FRACTIONS[fraction]} `);

  // Unicode superscript runs, e.g. x² or 10⁻³.
  out = out.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g, (run) => {
    const value = [...run].map((char) => SUPERSCRIPTS[char] ?? char).join('');
    if (value === '2') return ' squared ';
    if (value === '3') return ' cubed ';
    return ` to the power of ${value} `;
  });

  // Unicode subscripts, e.g. x₁.
  out = out.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]+/g, (run) => {
    const value = [...run].map((char) => SUBSCRIPT_DIGITS[char] ?? char).join('');
    return ` sub ${value} `;
  });

  return out;
}

function replaceExponents(text: string): string {
  return text
    .replace(/\^\s*\{\s*2\s*\}/g, ' squared ')
    .replace(/\^\s*\{\s*3\s*\}/g, ' cubed ')
    .replace(/\^\s*\{\s*([^{}]+?)\s*\}/g, ' to the power of $1 ')
    .replace(/\^\s*2\b/g, ' squared ')
    .replace(/\^\s*3\b/g, ' cubed ')
    .replace(/\^\s*([A-Za-z0-9.]+)/g, ' to the power of $1 ')
    .replace(/_\s*\{\s*([^{}]+?)\s*\}/g, ' sub $1 ')
    .replace(/_\s*([A-Za-z0-9]+)/g, ' sub $1 ');
}

function looksMathematical(text: string): boolean {
  if (/https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.\w+/.test(text)) return false;
  if (/\\[a-zA-Z]+|\$[^$]+\$|\^|_\{/.test(text)) return true;
  if (/[=±×÷≠≤≥≈≡∑∫√∞²³⁴⁵⁶⁷⁸⁹]/.test(text)) return true;
  // Symbolic expressions such as "a - b" or "x = y". Requiring spaces keeps
  // hyphenated prose ("state-of-the-art") and read/write paths out of this path.
  if (/[A-Za-z0-9)\]]\s+[-+*/=<>]\s+[A-Za-z0-9(\[]/.test(text)) return true;
  if (/\b\d+(?:\.\d+)?\s*[-+*/=<>]\s*\d+/.test(text)) return true;
  return false;
}

/**
 * Expand mathematical notation in `input` into speakable words.
 *
 * @param input Original segment text.
 * @returns Text suitable for the Web Speech API / Kokoro server.
 */
export function toSpeechText(input: string): string {
  if (!input || !input.trim()) return input;

  let text = replaceLatex(input);
  text = replaceUnicodePowers(text);
  text = replaceExponents(text);

  // Symbols that are safe to expand in any context.
  text = text.replace(/[×·÷±∓≤≥≠≈≅≡∞∑∏∫√∂∇∈∉⊂⊆∪∩→⇒⇔∝∴°%′″…−–—]/g, (symbol) => SYMBOLS[symbol] ?? symbol);
  text = text.replace(/[α-ωΑ-Ω]/g, (symbol) => GREEK[symbol] ?? symbol);

  const mathLike = looksMathematical(input) || looksMathematical(text);

  if (mathLike) {
    text = text
      .replace(/<=/g, ' less than or equal to ')
      .replace(/>=/g, ' greater than or equal to ')
      .replace(/!=/g, ' not equal to ')
      .replace(/==/g, ' equals ')
      .replace(/=/g, ' equals ')
      .replace(/(?<=\s)\+(?=\s)/g, ' plus ')
      .replace(/(?<=[\w)\]])\+(?=[\w(\[])/g, ' plus ')
      .replace(/(?<=\s)-(?=\s)/g, ' minus ')
      .replace(/-(?=\d)/g, ' minus ')
      .replace(/\*(?=\s)/g, ' times ')
      .replace(/\//g, ' divided by ')
      .replace(/<(?=\s|[\w(])/g, ' less than ')
      .replace(/(?<=\s|[\w)])>/g, ' greater than ');
  }

  return text
    .replace(/[{}]/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** True when the text contains notation that `toSpeechText` will change. */
export function hasSpeakableMath(input: string): boolean {
  return toSpeechText(input) !== input.trim();
}
