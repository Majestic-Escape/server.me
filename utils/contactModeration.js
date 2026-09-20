// GENERATED FILE — do not edit by hand.
// Contact-information detector, emitted from majestic-chat
// packages/shared/src/moderation/patterns.ts (commit ba7e4cf) by
// packages/shared/scripts/emit-contact-moderation-cjs.js. The TypeScript
// source is the only implementation; tests/batch-s/contact-moderation.test.js
// asserts the shared golden corpus (tests/batch-s/fixtures/contact-vectors.json)
// against this file, and the release harness checks the corpus is
// byte-identical in both repositories. Regenerate after any change there:
//   (majestic-chat) npm run build:shared && node packages/shared/scripts/emit-contact-moderation-cjs.js ../server.me/utils/contactModeration.js
/* eslint-disable */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NAME_MAX_LENGTH = exports.MODERATION_PATTERNS = exports.ALLOWED_URL_DOMAINS = exports.MASK = exports.BLOCKING_PATTERNS = exports.PatternType = void 0;
exports.normalizeForModeration = normalizeForModeration;
exports.isValidTld = isValidTld;
exports.buildAddressTokens = buildAddressTokens;
exports.detectContact = detectContact;
exports.applyMask = applyMask;
exports.maskContactInfo = maskContactInfo;
exports.detectContactInParts = detectContactInParts;
exports.maskContactInfoParts = maskContactInfoParts;
exports.checkCandidate = checkCandidate;
exports.checkText = checkText;
exports.calculateConfidence = calculateConfidence;
exports.getModerationStatus = getModerationStatus;
exports.isContextRelevant = isContextRelevant;
exports.isFragmentBearing = isFragmentBearing;
exports.isAcceptableName = isAcceptableName;
const chat_types_1 = { ModerationStatus: { CLEAN: 'clean', FLAGGED: 'flagged', BLOCKED: 'blocked' } };
/**
 * Contact-information detector shared by the chat server (live moderation,
 * cross-message window, legacy history masking) and — as a CommonJS mirror
 * kept in parity by the golden corpus in `__fixtures__/contact-vectors.json`
 * — by server.me (public-text writes and public reads).
 *
 * Policy (owner decision, 2026-09-20): any contact identifier (phone in any
 * spelling/script/split, email/obfuscated email, UPI id, URL/domain/IP,
 * social handle), any off-platform channel / payment / direct-booking
 * mention, and any disclosure of a listing's exact address are BLOCKED;
 * bare intent without data ("call me") is FLAGGED (delivered, logged).
 *
 * Every pattern is linear in the input: bounded quantifiers only, one pass
 * per pattern, and the normaliser is a single left-to-right sweep that keeps
 * a map from normalised characters back to the original offsets so hits can
 * be masked in the original text. A 4000-character adversarial message is
 * processed in a few milliseconds (asserted in the tests).
 */
var PatternType;
(function (PatternType) {
    PatternType["INDIAN_PHONE"] = "INDIAN_PHONE";
    PatternType["SPACED_PHONE"] = "SPACED_PHONE";
    PatternType["INTL_PHONE"] = "INTL_PHONE";
    PatternType["SPLIT_PHONE"] = "SPLIT_PHONE";
    PatternType["EMAIL"] = "EMAIL";
    PatternType["OBFUSCATED_EMAIL"] = "OBFUSCATED_EMAIL";
    PatternType["EMAIL_PROVIDER"] = "EMAIL_PROVIDER";
    PatternType["UPI"] = "UPI";
    PatternType["URL"] = "URL";
    PatternType["WHATSAPP"] = "WHATSAPP";
    PatternType["TELEGRAM"] = "TELEGRAM";
    PatternType["SIGNAL"] = "SIGNAL";
    PatternType["SOCIAL"] = "SOCIAL";
    PatternType["OFF_PLATFORM"] = "OFF_PLATFORM";
    PatternType["ADDRESS"] = "ADDRESS";
    PatternType["CONTACT_INTENT"] = "CONTACT_INTENT";
})(PatternType || (exports.PatternType = PatternType = {}));
/** Kinds that carry (or lead to) an actual contact channel → BLOCKED. */
exports.BLOCKING_PATTERNS = new Set([
    PatternType.INDIAN_PHONE,
    PatternType.SPACED_PHONE,
    PatternType.INTL_PHONE,
    PatternType.SPLIT_PHONE,
    PatternType.EMAIL,
    PatternType.OBFUSCATED_EMAIL,
    PatternType.EMAIL_PROVIDER,
    PatternType.UPI,
    PatternType.URL,
    PatternType.WHATSAPP,
    PatternType.TELEGRAM,
    PatternType.SIGNAL,
    PatternType.SOCIAL,
    PatternType.OFF_PLATFORM,
    PatternType.ADDRESS,
]);
exports.MASK = '•••';
/** Hostnames (and their subdomains) that may appear as URLs. Never applies to emails. */
exports.ALLOWED_URL_DOMAINS = ['majesticescape.in', 'majesticescape.com'];
// Characters that carry no visible content and are used to split identifiers.
const STRIP_RE = /[\u200B-\u200F\u2060-\u2064\uFEFF\uFE00-\uFE0F\u20E3\u034F\u180E\u00AD\u2028\u2029\u0301-\u036F]/u;
const ND_RE = /\p{Nd}/u;
// Dot look-alikes used to disguise a domain: ideographic / halfwidth full stops,
// katakana middle dot, one-dot leader, middle dot, hyphenation point, dot operator, bullet operator.
const DOT_LIKE_RE = /[\u3002\uFF61\u30FB\u2024\u00B7\u2027\u22C5\u2219]/u;
function digitValue(ch) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x30 && cp <= 0x39)
        return ch;
    // Unicode decimal digits sit in ascending runs of ten; walk back to the run's zero.
    let zero = cp;
    for (let i = 0; i < 9; i++) {
        const prev = String.fromCodePoint(zero - 1);
        if (!ND_RE.test(prev))
            break;
        zero -= 1;
    }
    return String((cp - zero) % 10);
}
const NUMBER_WORDS = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    oh: '0', // "nine eight oh"
    ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
    twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
    shunya: '0', sifar: '0', ek: '1', do: '2', teen: '3', tin: '3', char: '4', chaar: '4', paanch: '5', panch: '5', pach: '5',
    chhe: '6', che: '6', chha: '6', saat: '7', sat: '7', aath: '8', ath: '8', nau: '9', nou: '9',
};
/** Stage 1: per code point NFKC + lower-case + digit folding + strip. */
function foldCharacters(original) {
    const out = [];
    let i = 0;
    while (i < original.length) {
        const cp = original.codePointAt(i);
        const len = cp > 0xffff ? 2 : 1;
        const raw = original.slice(i, i + len);
        if (!STRIP_RE.test(raw)) {
            const folded = raw.normalize('NFKC').toLowerCase();
            for (const ch of folded) {
                if (STRIP_RE.test(ch))
                    continue;
                out.push({ s: ND_RE.test(ch) ? digitValue(ch) : DOT_LIKE_RE.test(ch) ? '.' : ch, from: i, to: i + len });
            }
        }
        i += len;
    }
    return out;
}
const WORD_CHAR = /[a-z0-9]/;
function tokenize(pieces) {
    const tokens = [];
    let i = 0;
    while (i < pieces.length) {
        if (!WORD_CHAR.test(pieces[i].s)) {
            i++;
            continue;
        }
        let j = i;
        let text = '';
        while (j < pieces.length && WORD_CHAR.test(pieces[j].s)) {
            text += pieces[j].s;
            j++;
        }
        tokens.push({ start: i, end: j, text });
        i = j;
    }
    return tokens;
}
const LOOKALIKE_TOKEN = /^[0-9oil]{2,}$/;
const LOOKALIKE_TOKEN_WIDE = /^[0-9oilsbzgq]{2,}$/;
/**
 * Stage 2: token rewrites — spelled-out digit runs (≥ 3 consecutive number
 * words / digits), letter look-alikes inside digit tokens, and the
 * "(at)" / "(dot)" / " at " / " dot " joiners of obfuscated emails and domains.
 */
function rewriteTokens(pieces) {
    const tokens = tokenize(pieces);
    const replaced = new Map(); // token index → replacement text
    const replacedSpan = new Map(); // token index → original span when a replacement covers several tokens
    // Number words: only inside a run of ≥ 3 numeric tokens (digits or words)
    // so "do you have", "one night" or "teen" never become digits.
    const REPEAT = { double: 2, triple: 3 };
    const numeric = tokens.map((t, k) => /^\d+$/.test(t.text) || NUMBER_WORDS[t.text] !== undefined || (REPEAT[t.text] !== undefined && k + 1 < tokens.length && NUMBER_WORDS[tokens[k + 1].text] !== undefined));
    let r = 0;
    while (r < tokens.length) {
        if (!numeric[r]) {
            r++;
            continue;
        }
        let e = r;
        while (e < tokens.length && numeric[e] && (e === r || gapIsSmall(pieces, tokens[e - 1], tokens[e])))
            e++;
        if (e - r >= 3) {
            for (let k = r; k < e; k++) {
                const w = NUMBER_WORDS[tokens[k].text];
                if (w !== undefined)
                    replaced.set(k, w);
                else if (REPEAT[tokens[k].text] !== undefined && k + 1 < e) {
                    // "double nine" → "99": the repeat word disappears, the digit repeats
                    replaced.set(k, '');
                    replaced.set(k + 1, NUMBER_WORDS[tokens[k + 1].text].repeat(REPEAT[tokens[k].text]));
                    k++;
                }
            }
        }
        r = Math.max(e, r + 1);
    }
    // Number words glued to digits inside one token: "98765four3210", "nine8seven".
    for (let k = 0; k < tokens.length; k++) {
        if (replaced.has(k))
            continue;
        const t = tokens[k].text;
        if (!/\d/.test(t) || !/[a-z]/.test(t) || t.length > 40)
            continue;
        const parts = t.match(/\d+|[a-z]+/g) || [];
        if (parts.length < 2 || !parts.every((x) => /^\d+$/.test(x) || NUMBER_WORDS[x] !== undefined))
            continue;
        replaced.set(k, parts.map((x) => (/^\d+$/.test(x) ? x : NUMBER_WORDS[x])).join(''));
    }
    // Look-alikes: a token made of digits and o/i/l/| with at least two real
    // digits; with s/b/z/g/q as well only when the token is phone-sized (≥ 10
    // characters, ≥ 6 real digits, at most two letters) so "b2b", "s10" or a
    // glued run of labels ("g0g1g2g3g4g5") are never touched.
    for (let k = 0; k < tokens.length; k++) {
        const t = tokens[k].text;
        if (replaced.has(k))
            continue;
        const digits = (t.match(/\d/g) || []).length;
        if (LOOKALIKE_TOKEN.test(t) && digits >= 2 && /[oil]/.test(t)) {
            replaced.set(k, t.replace(/o/g, '0').replace(/[il]/g, '1'));
        }
        else if (LOOKALIKE_TOKEN_WIDE.test(t) && t.length >= 10 && digits >= 6 && t.length - digits <= 2) {
            replaced.set(k, t.replace(/o/g, '0').replace(/[il]/g, '1').replace(/s/g, '5').replace(/b/g, '8').replace(/z/g, '2').replace(/[gq]/g, '9'));
        }
        else if (t === 'd0t' || t === 'dott' || t === 'd0tt') {
            replaced.set(k, 'dot');
        }
        else if (/^dot(com|net|org|in|co|io|me|info|xyz|site|online|shop|club|app|dev|travel)$/.test(t) && k > 0 && gapIsSmall(pieces, tokens[k - 1], tokens[k], 3)) {
            // "rahulvilla dotin" → "rahulvilla.in"
            replaced.set(k, '.' + t.slice(3));
        }
    }
    // Spaced-out letters: "r a h u l v i l l a . i n", "w h a t s a p p" — a run of
    // ≥ 5 single-character tokens separated by one space (a '.' or '@' may sit
    // between two of them) collapses into one token, punctuation kept.
    for (let k = 0; k < tokens.length; k++) {
        if (tokens[k].text.length !== 1 || replaced.has(k))
            continue;
        let e = k;
        while (e + 1 < tokens.length && tokens[e + 1].text.length === 1 && !replaced.has(e + 1)) {
            const gap = pieces.slice(tokens[e].end, tokens[e + 1].start).map((x) => x.s).join('');
            if (!/^\s?[.@]?\s?$/.test(gap) || gap.length === 0)
                break;
            e++;
        }
        if (e - k + 1 >= 5) {
            let text = '';
            for (let q = k; q <= e; q++) {
                if (q > k)
                    text += pieces.slice(tokens[q - 1].end, tokens[q].start).map((x) => x.s).join('').replace(/ /g, '');
                text += tokens[q].text;
                if (q > k)
                    replaced.set(q, '');
            }
            replaced.set(k, text);
            replacedSpan.set(k, [pieces[tokens[k].start].from, pieces[tokens[e].end - 1].to]);
            k = e;
        }
    }
    // Joiners: word (at) word → word@word ; word (dot) word → word.word ;
    // "word at word" only when a dot / "dot" / a mail provider follows within two tokens.
    const joiner = new Map(); // token index of "at"/"dot" → '@' | '.'
    // "rahulvilla(.)in", "rahul[.]sharma" — a bracketed dot between two tokens is a dot.
    const bracketDot = new Map(); // token index k: the gap BEFORE token k is "(.)"-like
    for (let k = 1; k < tokens.length; k++) {
        const gap = pieces.slice(tokens[k - 1].end, tokens[k].start).map((x) => x.s).join('');
        if (/^\s*[([{]\s*\.\s*[)\]}]\s*$/.test(gap))
            bracketDot.set(k, true);
    }
    for (let k = 1; k < tokens.length - 1; k++) {
        const t = replaced.get(k) ?? tokens[k].text;
        if (t !== 'at' && t !== 'dot')
            continue;
        const bracketed = isBracketed(pieces, tokens[k]);
        // A joiner only replaces separators: the gap on both sides must be
        // whitespace / punctuation, so "rahul@" + "dot com" stays two fragments
        // (no domain in sight) instead of collapsing into "rahul.com".
        const gapsClean = gapIsSmall(pieces, tokens[k - 1], tokens[k], 3) && gapIsSmall(pieces, tokens[k], tokens[k + 1], 3);
        if (!gapsClean)
            continue;
        if (t === 'dot') {
            joiner.set(k, '.');
            // "dot i n" — the TLD spelled letter by letter after the joiner
            if (tokens[k + 1].text.length === 1 && k + 2 < tokens.length && tokens[k + 2].text.length === 1) {
                let e = k + 1;
                let tld = tokens[e].text;
                while (e + 1 < tokens.length && tokens[e + 1].text.length === 1 && e - k < 4 && /^ $/.test(pieces.slice(tokens[e].end, tokens[e + 1].start).map((x) => x.s).join(''))) {
                    e++;
                    tld += tokens[e].text;
                }
                if (tld.length >= 2 && isValidTld(tld)) {
                    replaced.set(k + 1, tld);
                    replacedSpan.set(k + 1, [pieces[tokens[k + 1].start].from, pieces[tokens[e].end - 1].to]);
                    for (let q = k + 2; q <= e; q++)
                        replaced.set(q, '');
                }
            }
        }
        else if (t === 'at') {
            const next = tokens[k + 1]?.text || '';
            const nextNext = tokens[k + 2]?.text || '';
            const providerAhead = PROVIDER_WORDS.has(next) || PROVIDER_WORDS.has(nextNext);
            const dotAhead = nextNext === 'dot' || (tokens[k + 1] && hasDotAfter(pieces, tokens[k + 1]));
            if (bracketed || providerAhead || dotAhead)
                joiner.set(k, '@');
        }
    }
    if (replaced.size === 0 && joiner.size === 0 && bracketDot.size === 0)
        return pieces;
    const out = [];
    const outEndOfToken = []; // out.length right after token k was emitted
    let p = 0;
    for (let k = 0; k < tokens.length; k++) {
        const tok = tokens[k];
        const j = joiner.get(k);
        if (j !== undefined) {
            // The joiner replaces everything between the previous and the next
            // token (brackets, spaces and the word itself) with a single '@' / '.'.
            out.length = outEndOfToken[k - 1];
            const prevEnd = tokens[k - 1].end;
            const nextStart = tokens[k + 1].start;
            out.push({ s: j, from: pieces[prevEnd].from, to: pieces[nextStart - 1].to });
            outEndOfToken[k] = out.length;
            p = nextStart;
            continue;
        }
        // copy the gap before the token (a bracketed dot becomes a plain dot)
        if (bracketDot.has(k) && k > 0) {
            const prevEnd = tokens[k - 1].end;
            if (p < tok.start)
                out.push({ s: '.', from: pieces[prevEnd].from, to: pieces[tok.start - 1].to });
            p = tok.start;
        }
        while (p < tok.start)
            out.push(pieces[p++]);
        const rep = replaced.get(k);
        if (rep === '') {
            // collapsed into the previous token: drop the token and the gap before it
            out.length = outEndOfToken[k - 1] !== undefined ? outEndOfToken[k - 1] : out.length;
            p = tok.end;
        }
        else if (rep !== undefined) {
            const span = replacedSpan.get(k);
            const from = span ? span[0] : pieces[tok.start].from;
            const to = span ? span[1] : pieces[tok.end - 1].to;
            for (const ch of rep)
                out.push({ s: ch, from, to });
            p = tok.end;
        }
        else {
            while (p < tok.end)
                out.push(pieces[p++]);
        }
        outEndOfToken[k] = out.length;
    }
    while (p < pieces.length)
        out.push(pieces[p++]);
    return out;
}
const PROVIDER_WORDS = new Set(['gmail', 'googlemail', 'yahoo', 'ymail', 'hotmail', 'outlook', 'live', 'protonmail', 'proton', 'rediffmail', 'rediff', 'icloud', 'zoho', 'aol', 'mail']);
function gapIsSmall(pieces, a, b, max = 3) {
    const gap = pieces.slice(a.end, b.start).map((x) => x.s).join('');
    return gap.length <= max && /^[\s.,\-_/()[\]{}*|:;]*$/.test(gap);
}
function isBracketed(pieces, t) {
    let l = t.start - 1;
    while (l >= 0 && pieces[l].s === ' ')
        l--;
    let r = t.end;
    while (r < pieces.length && pieces[r].s === ' ')
        r++;
    const left = l >= 0 ? pieces[l].s : '';
    const right = r < pieces.length ? pieces[r].s : '';
    return (left === '(' && right === ')') || (left === '[' && right === ']') || (left === '{' && right === '}') || (left === '<' && right === '>');
}
function hasDotAfter(pieces, t) {
    return t.end < pieces.length && pieces[t.end].s === '.' && t.end + 1 < pieces.length && WORD_CHAR.test(pieces[t.end + 1].s);
}
function normalizeForModeration(original) {
    const pieces = rewriteTokens(foldCharacters(original));
    const text = [];
    const from = [];
    const to = [];
    // from/to are indexed by UTF-16 code unit of the normalised text, the unit
    // regex indexes count in: an astral piece (an emoji) is two units, so it
    // gets two entries — otherwise every offset after it is off by one and a
    // hit ending the text maps to `undefined` and is silently dropped.
    for (const piece of pieces) {
        text.push(piece.s);
        for (let k = 0; k < piece.s.length; k++) {
            from.push(piece.from);
            to.push(piece.to);
        }
    }
    return { original, text: text.join(''), from, to };
}
// ---------------------------------------------------------------------------
// TLDs (URL detection validates the last label instead of trusting any ".xx")
// ---------------------------------------------------------------------------
const CC_TLDS = new Set('ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw'.split(' '));
const G_TLDS = new Set('com net org info biz name pro mobi tel travel hotel hotels club dev app xyz site online link page shop store tech ai io me co in cloud space live world today news blog wiki web website email mail chat digital agency studio design photo photos pics pictures video media group company business ltd inc llc int edu gov mil asia africa nyc london delhi mumbai goa villa villas apartments rentals rent house homes estate property properties holiday holidays vacations tours travel tips guide guru expert services solutions center centre care health life family fun games art bar cafe restaurant pizza wine beer food kitchen zone one top best cool vip fan fans social network click direct life host hosting run team work works global india bharat desi ooo icu buzz fit fitness yoga spa beach island resort resorts'.split(' '));
function isValidTld(label) {
    if (!label)
        return false;
    if (label.startsWith('xn--'))
        return label.length > 4;
    return CC_TLDS.has(label) || G_TLDS.has(label);
}
function isAllowedUrlHost(host) {
    const h = host.toLowerCase().replace(/\.$/, '');
    return exports.ALLOWED_URL_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}
// ---------------------------------------------------------------------------
// Patterns (run on the normalised text; every quantifier is bounded)
// ---------------------------------------------------------------------------
// 10 digits starting 6–9 with up to three separator characters between any two digits.
// Separators inside one number never include a line break: digits on separate
// lines / in separate messages are SPLIT_PHONE's job, with its explanation rules.
const PHONE_RE = /(?<!\d)(?:(?:\+|00)?91[ 	.\-()]{0,3})?(?:0[ 	.\-]{0,2})?([6-9](?:[ 	.\-_()/*|:;]{0,3}\d){9})(?![ 	.\-_()/*|:;]{0,3}\d)/g;
const INTL_PHONE_RE = /(?<![\d+])\+(?:\d[ 	.\-()]{0,2}){7,14}\d(?!\d)/g;
const EMAIL_RE = /[a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?){0,4}\.[a-z]{2,24}(?![a-z0-9])/g;
const PROVIDER_RE = /(?<![a-z0-9])(gmail|googlemail|yahoo|ymail|hotmail|outlook|protonmail|proton\.me|rediffmail|rediff|icloud|zoho|aol)(?![a-z0-9])/g;
const UPI_RE = /(?<![a-z0-9._\-])[a-z0-9][a-z0-9._\-]{1,63}@(ybl|oksbi|okaxis|okhdfcbank|okicici|paytm|upi|apl|ibl|axl|ptyes|ptsbi|ptaxis|yapl|fam|axisb|sbi|hdfcbank|icici|kotak|jio|airtel|freecharge|waaxis|wahdfcbank|waicici|wasbi|okbizaxis|axisbank|barodampay|cnrb|indus|federal|pnb|uco|idfcbank|yesbank|rbl|dbs|kbl|abfspay|ikwik|naviaxis|slice)(?![a-z0-9])/g;
const HANDLE_RE = /(?<![a-z0-9])@[a-z][a-z0-9_.]{3,30}(?![a-z0-9_])/g;
// host and TLD separated by spaces around the dot: group 2 is the separator (starts with a space when the space precedes the dot)
const SPACED_DOMAIN_RE = /(?<![a-z0-9@.\-_/])([a-z0-9][a-z0-9\-]{2,61})((?: ?\. {1,2})|(?: {1,2}\. ?))([a-z]{2,24})(?![a-z0-9\-@])/g;
// www / http lead-in with the dots replaced by spaces or missing
// TLDs that are NOT ordinary words or abbreviations: after a sentence-ending
// period they can only be a domain ("rahulvilla. Com"). Every other TLD in the
// tables — in, it, host, travel, site, club, today… — is also plain English,
// so ". Hosting gives me", "stay. Host was", "beach. in the morning" are prose
// unless a lead-in cue ("see", "visit", "website" …) precedes the host.
const NON_WORD_TLDS = new Set('com net org co io ly gl gg xyz ooo icu mobi cc tk ml ga cf gq'.split(' '));
const isWordLikeTld = (tld) => !NON_WORD_TLDS.has(tld);
const URL_LEAD_IN_RE = /(?:^|[^a-z])(?:visit|see|check|checkout|website|site|web|www|browse|open|search|google|find (?:us|me)|link|url|log ?on|go to|head to|type|https?:?)\s*$/;
const SPACED_URL_RE = /(?<![a-z0-9])(?:https?|www)[\s:/.]{1,4}([a-z0-9][a-z0-9\-]{1,61})[\s.]{1,3}([a-z]{2,24})(?![a-z0-9])/g;
const URL_SCHEME_RE = /(?:https?:\/\/|www\.)[^\s<>"']{1,200}/g;
const IPV4_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const DOMAIN_RE = /(?<![a-z0-9@.\-_/])([a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?){0,3})\.([a-z]{2,24}|xn--[a-z0-9\-]{2,59})(?![a-z0-9\-@])/g;
const SOCIAL_RE = /(?<![a-z0-9])(whats\s?app|watsap|watsapp|whatsap|wapp|wa\.me|wa\s*(?:me|number|no|:)|(?:on|my|via)\s+wa|telegram|t\.me|tg\s+[a-z0-9_@][a-z0-9_.]*|signal\s{0,3}(?:app|number|me|id)|insta(?:gram)?|ig\s*(?:id|handle|:|@)|facebook|fb\s*(?:id|page|profile|messenger|:|@)|fb\s+[a-z][a-z0-9_.]*|messenger|snapchat|snap\s*(?:id|me|:|@)|(?:on|my|via)\s+snap|snap\s+[a-z0-9_.]*[\d_.][a-z0-9_.]*|linkedin|twitter|x\.com|discord|skype|imo\s*(?:number|app|id|:|@)|(?:on|my|via)\s+imo|imo\s+[a-z0-9_.]*[\d_.][a-z0-9_.]*|viber|wechat|line\s+id|threema|zalo|hike\s*(?:app|id|me|:|@)|(?:on|my|via)\s+hike|threads\s*[:@]|threads\s+[a-z0-9_.]*[\d_.][a-z0-9_.]*|(?:on|my|via)\s+tik\s?tok|tik\s?tok\s*[:@]|tik\s?tok\s+[a-z0-9_.]*[\d_.][a-z0-9_.]*|youtube\s*(?:\.com\/|:|@|channel\s*[:@])|yt\s*[:@]|bit[\s.]?ly|tinyurl|tiny[\s.]?url|goo[\s.]?gl|cutt[\s.]?ly|rb[\s.]?gy|is[\s.]gd|shorturl|linktr[\s.]?ee|linktree)(?![a-z0-9])/g;
const OFF_PLATFORM_RE = /(?<![a-z0-9])(book(?:ing)?\s+directly|direct\s+booking|directly\s+(?:with|to|from)\s+(?:me|us|you)|outside\s+(?:of\s+)?(?:the\s+)?(?:app|site|website|platform|portal|majestic)|off\s+(?:the\s+)?(?:app|site|platform)|skip\s+(?:the\s+)?(?:app|site|website|platform|commission|fee)|avoid\s+(?:the\s+)?(?:commission|platform\s+fee|service\s+fee)|pay\s+(?:me\s+|us\s+)?(?:directly|cash|offline|in\s+cash|by\s+cash)|cash\s+on\s+arrival|cash\s+at\s+(?:check\s?in|arrival)|g\s?pay|google\s+pay|phone\s?pe|paytm|upi|bank\s+transfer|neft|imps|rtgs|account\s+(?:number|no)|a\/c\s+no|acct?\s+no|ifsc|deal\s+(?:offline|directly|outside|off\s+the\s+(?:app|site|platform|record))|offline\s+deal|under\s+the\s+table|no\s+need\s+(?:for|of)\s+(?:the\s+)?(?:app|site|platform|website)|without\s+(?:the\s+)?(?:app|site|platform|website|commission))(?![a-z0-9])/g;
const CONTACT_INTENT_RE = /(?<![a-z0-9])(?:call|text|reach|contact|message|ping|dm)\s{0,3}(?:me|us)\s{0,3}(?:on|at|via|@)?/g;
const GENERIC_ADDRESS_WORDS = new Set('road rd lane ln street st nagar near opposite opp behind next to the of and at in on no number num house h plot flat villa apartment apt building bldg colony society sector phase main cross first second third fourth floor gate north south east west new old block wing tower complex enclave vihar marg path gali chowk circle square park garden estate layout extension extn stage area village town city district taluka post office po pin pincode zip india goa maharashtra karnataka kerala rajasthan beach'.split(' '));
// A street-type word makes a 2-gram meaningful together with one distinctive
// word ("holiday street", "sunset lane"); two generic words never do ("main road").
const STREET_TYPE_WORDS = new Set('road rd lane ln street st nagar marg path gali chowk colony society enclave vihar layout extension extn complex tower wing block villa apartment apt building bldg estate garden park circle square cross avenue ave drive dr close court ct place pl heights hills hill view vista residency residence retreat farm farms cottage cottages homestay resort beach'.split(' '));
// Everything after a landmark preposition describes the surroundings, not the address.
const LANDMARK_PREPOSITIONS = new Set(['near', 'opposite', 'opp', 'behind', 'next', 'beside', 'close', 'adjacent', 'nearby', 'facing', 'off']);
// A one-digit house number counts only together with the word that introduces it.
const HOUSE_NUMBER_WORDS = new Set(['house', 'plot', 'flat', 'no', 'number', 'h', 'door', 'villa', 'bungalow', 'unit', 'shop', 'gate', 'block']);
/** Build the tokens of an exact address that must not be disclosed in public text. */
function buildAddressTokens(addr) {
    const empty = { numbers: [], grams: [] };
    if (!addr)
        return empty;
    const locality = new Set([addr.city, addr.district, addr.state]
        .filter((x) => !!x)
        .flatMap((x) => normalizeForModeration(x).text.split(/[^a-z0-9]+/))
        .filter(Boolean));
    const numbers = new Set();
    const grams = new Set();
    for (const raw of [addr.street, addr.line1, addr.line2]) {
        if (!raw)
            continue;
        const words = normalizeForModeration(raw)
            .text.split(/[^a-z0-9/\-]+/)
            .map((w) => w.replace(/^[/\-]+|[/\-]+$/g, ''))
            .filter(Boolean);
        const kinds = []; // distinctive / street-type / break
        const seen = [];
        let landmark = false;
        let prevWord = '';
        for (const w of words) {
            if (LANDMARK_PREPOSITIONS.has(w))
                landmark = true;
            if (/\d/.test(w)) {
                // "72", "72/b", "h-12", "1203": a house/plot/flat number with at least
                // two characters, or a single digit right after a house/plot word
                // ("house 9") — matched in text only with such a word in front.
                const single = w.length === 1;
                if (!landmark && !/^\d{6}$/.test(w) /* pincode */ && !/^(?:19|20)\d{2}$/.test(w) /* a year */) {
                    if (!single)
                        numbers.add(w);
                    else if (HOUSE_NUMBER_WORDS.has(prevWord))
                        numbers.add(`${prevWord} ${w}`);
                }
                kinds.push('');
                seen.push(w);
                prevWord = w;
                continue;
            }
            prevWord = w;
            if (landmark || w.length < 3 || locality.has(w)) {
                kinds.push('');
                seen.push(w);
                continue;
            }
            kinds.push(STREET_TYPE_WORDS.has(w) ? 't' : GENERIC_ADDRESS_WORDS.has(w) ? '' : 'd');
            seen.push(w);
        }
        for (let i = 0; i + 1 < seen.length; i++) {
            const a = kinds[i];
            const b = kinds[i + 1];
            if ((a === 'd' && (b === 'd' || b === 't')) || (a === 't' && b === 'd'))
                grams.add(`${seen[i]} ${seen[i + 1]}`);
        }
        // A single very distinctive word (≥ 8 letters, e.g. "sunshinevilla") counts on its own.
        seen.forEach((w, i) => {
            if (kinds[i] === 'd' && w.length >= 8)
                grams.add(w);
        });
    }
    return { numbers: [...numbers], grams: [...grams] };
}
function detectAddress(norm, tokensOpt) {
    const list = Array.isArray(tokensOpt) ? tokensOpt : [tokensOpt];
    const hits = [];
    const text = norm.text;
    for (const tokens of list) {
        if (!tokens || (!tokens.numbers.length && !tokens.grams.length))
            continue;
        const gramHits = [];
        for (const g of tokens.grams) {
            const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(g).replace(/ /g, '[\\s,.\\-]{1,3}')}(?![a-z0-9])`, 'g');
            let m;
            while ((m = re.exec(text)))
                gramHits.push([m.index, m.index + m[0].length]);
        }
        const numberHits = [];
        for (const n of tokens.numbers) {
            const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(n).replace(/ /g, '[\\s.,#:-]{0,3}')}(?![a-z0-9])`, 'g');
            let m;
            while ((m = re.exec(text)))
                numberHits.push([m.index, m.index + m[0].length]);
        }
        const disclosed = (numberHits.length > 0 && gramHits.length > 0) || gramHits.length >= 2;
        if (!disclosed)
            continue;
        for (const [s, e] of [...gramHits, ...(gramHits.length ? numberHits : [])])
            hits.push(toOriginalHit(norm, PatternType.ADDRESS, s, e));
    }
    return hits;
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
function toOriginalHit(norm, pattern, s, e) {
    const start = norm.from[s];
    let end = norm.to[e - 1];
    // A hit that ends right before stripped characters (keycaps, zero-width
    // joiners) swallows them so the mask leaves no dangling combining marks.
    const nextFrom = e < norm.from.length ? norm.from[e] : Infinity;
    while (end < nextFrom && end < norm.original.length && STRIP_RE.test(norm.original[end]))
        end++;
    return { pattern, start, end, match: norm.text.slice(s, e) };
}
const PART_SEPARATOR = '\n';
// Digit tokens that a normal conversation explains (counts, dates, money, times…).
// Digit tokens that a normal conversation explains (counts, dates, money, times…).
// Small numbers (≤ 4 digits) are explained by positional and count words; a
// 5+ digit token is only ever explained by money / size context or by being a
// round amount, because "call me at 98765" must not launder a phone fragment.
const EXPLAINING_PREV_SMALL = /^(?:rs|inr|usd|eur|price|prices|cost|costs|rate|rates|rent|fee|fees|charge|charges|deposit|advance|amount|total|budget|pay|paid|paying|room|rooms|flat|house|plot|door|gate|floor|unit|no|number|num|age|aged|pin|pincode|zip|booking|ref|reference|id|order|invoice|otp|code|year|dated|date|on|by|at|around|about|approx|approximately|km|kms|min|mins|day|days|week|weeks|month|months|guests|adults|kids|children|nights|people|persons|pax|group|of|x|for|till|until|upto|from|between|before|after|than|checkin|checkout|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|since|new|the)$/;
const EXPLAINING_PREV_LARGE = /^(?:rs|inr|usd|eur|price|prices|cost|costs|rate|rates|rent|fee|fees|charge|charges|deposit|advance|amount|total|budget|pay|paid|paying|sqft|area|pin|pincode|zip)$/;
const EXPLAINING_NEXT_SMALL = /^(?:pm|am|hrs|hr|hours|hour|minutes|mins|min|o'clock|oclock|guests|guest|adults|adult|kids|kid|children|child|infants|infant|nights|night|days|day|weeks|week|months|month|years|year|rooms|room|beds|bed|bedrooms|bedroom|bathrooms|bathroom|bhk|people|persons|person|pax|km|kms|m|meters|metres|mtrs|feet|ft|sqft|sq|acres|acre|floor|floors|star|stars|bottles|bottle|litres|liters|kg|percent|%|rs|inr|rupees|lakh|lakhs|k|total|per|each|only|approx|onwards|pcs|pieces|cars|car|bikes|bike|seater|seats|seat|pool|pools|villas|villa|extra|more|less|off|discount|th|st|nd|rd|sec|seconds|second|dogs|dog|cats|cat|pets|pet|toddlers|toddler|families|family|couples|couple|friends|friend|to|till|until|onwards)$/;
const EXPLAINING_NEXT_LARGE = /^(?:rs|inr|rupees|lakh|lakhs|k|total|sqft|sq|per|each|only|onwards|off|discount|percent|%|night|nights)$/;
const STATE_WORDS = /^(?:india|goa|kerala|karnataka|maharashtra|tamil|nadu|delhi|mumbai|bangalore|bengaluru|pune|hyderabad|chennai|kolkata|kochi|jaipur|rajasthan|gujarat|punjab|haryana|bengal|assam|bihar|odisha|telangana|andhra|uttarakhand|himachal|uttar|pradesh|madhya|chhattisgarh|jharkhand|sikkim|meghalaya|manipur|tripura|nagaland|mizoram|arunachal|ladakh|jammu|kashmir|chandigarh|puducherry|pondicherry|lakshadweep|andaman|daman|diu|dadra)$/;
// "12/10", "12-10-2024", "1/1/25": a calendar date needs plausible day and
// month values — "90-8" (ninety-eight) is a number read aloud, not a date.
function looksLikeDate(t) {
    const m = t.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
    if (!m)
        return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a >= 1 && b >= 1 && a <= 31 && b <= 31 && (a <= 12 || b <= 12);
}
/** Unexplained digit tokens of the text, with their normalised spans. */
function unexplainedDigitTokens(norm) {
    const text = norm.text;
    const out = [];
    const re = /[a-z0-9][a-z0-9'.:/\-]*|[^\sa-z0-9]/g;
    const tokens = [];
    let m;
    while ((m = re.exec(text)))
        tokens.push({ s: m.index, e: m.index + m[0].length, t: m[0] });
    // Digit tokens that sit in a run of ≥ 4 digit-only tokens separated by
    // nothing but separators ("on 9 8 7 6 5 4 3 2 1 0") are a number read
    // aloud, whatever word introduces the run — no count / date word explains them.
    const isDigitTok = (x) => /^\d+(?:[-/.:]\d+)*[.:/'\-]*$/.test(x.t);
    const runLen = new Array(tokens.length).fill(0);
    for (let i = 0; i < tokens.length; i++) {
        if (!isDigitTok(tokens[i]) || runLen[i])
            continue;
        let e = i;
        while (e + 1 < tokens.length && isDigitTok(tokens[e + 1]) && /^[\s.,\-()/*|:;]{0,3}$/.test(text.slice(tokens[e].e, tokens[e + 1].s)))
            e++;
        for (let q = i; q <= e; q++)
            runLen[q] = e - i + 1;
    }
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        let t = tok.t.replace(/[.:/'\-]+$/, '');
        // "90-8", "98-76-54-32-10": digits joined by separators inside one token (dates / times are excluded below)
        if (/^\d+(?:[-/.:]\d+)+$/.test(t) && !looksLikeDate(t) && !/^\d{1,2}:\d{2}/.test(t))
            t = t.replace(/[-/.:]/g, '');
        if (!/^\d+$/.test(t))
            continue;
        const inRun = runLen[i] >= 4;
        const prev = i > 0 ? tokens[i - 1].t : '';
        const next = (i + 1 < tokens.length ? tokens[i + 1].t : '').replace(/[.:/'\-]+$/, '');
        const prevWord = prev.replace(/[.:/'\-]+$/, '');
        const large = t.length >= 5;
        if (looksLikeDate(tok.t) || /^\d{1,2}:\d{2}/.test(tok.t))
            continue; // date / time
        if (/^(?:19|20)\d{2}$/.test(t) && (EXPLAINING_PREV_SMALL.test(prevWord) || /^(?:to|till|until|onwards)$/.test(next)))
            continue; // a year in context
        if (t.length === 6 && (/^(?:pin|pincode|zip|code)$/.test(prevWord) || STATE_WORDS.test(next)))
            continue; // a pincode in context
        if (t.length >= 4 && /00$/.test(t))
            continue; // a round amount
        if (i > 0 && /^[₹$]$/.test(prev))
            continue; // currency symbol
        if (!inRun && (large ? EXPLAINING_PREV_LARGE.test(prevWord) : EXPLAINING_PREV_SMALL.test(prevWord)))
            continue;
        if (!inRun && (large ? EXPLAINING_NEXT_LARGE.test(next) : EXPLAINING_NEXT_SMALL.test(next)))
            continue;
        out.push({ s: tok.s, e: tok.s + tok.t.replace(/[.:/'\-]+$/, '').length, digits: t });
    }
    // A one- or two-digit token only counts as a phone fragment when it is
    // "bare" — its segment (a message, or a field) holds nothing but digits and
    // separators ("9", "98 76") — or sits right next to another digit token
    // ("98 76 54 32 10"). A labelled small number ("burst 14", "day 6",
    // "we are 4") is a count, not a fragment, whatever the messages around it.
    const segments = text.split(PART_SEPARATOR);
    const segmentStart = [];
    let off = 0;
    for (const seg of segments) {
        segmentStart.push(off);
        off += seg.length + PART_SEPARATOR.length;
    }
    const bare = segments.map((seg) => /^[\s\d.,\-()/*|+]*$/.test(seg) && /\d/.test(seg));
    const segmentOf = (pos) => {
        let lo = 0;
        let hi = segmentStart.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (segmentStart[mid] <= pos)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lo;
    };
    const kept = out.filter((tok, i) => {
        if (tok.digits.length >= 3)
            return true;
        const seg = segmentOf(tok.s);
        if (bare[seg])
            return true;
        const near = (o) => segmentOf(o.s) === seg && /^[\s.,\-()/*|]{0,3}$/.test(text.slice(Math.min(o.e, tok.e), Math.max(o.s, tok.s)));
        return (i > 0 && near(out[i - 1])) || (i + 1 < out.length && near(out[i + 1]));
    });
    // An enumeration ("1", "2", "3" …) is a consecutive ascending run of small
    // numbers, not a phone number spelt one digit per message: a token that
    // continues such a run from the previous fragment is dropped.
    // (a run needs three consecutive values: "8" then "9" alone is not one)
    return kept.filter((tok, i) => {
        if (i < 2 || tok.digits.length > 2)
            return true;
        const prev = kept[i - 1].digits;
        const prev2 = kept[i - 2].digits;
        return !(prev.length <= 2 && prev2.length <= 2 && Number(tok.digits) === Number(prev) + 1 && Number(prev) === Number(prev2) + 1);
    });
}
/**
 * SPLIT_PHONE: the unexplained digit tokens, concatenated in order, contain a
 * 10-digit window starting 6–9 that spans at least two tokens (a single token
 * is the PHONE rule's job). Returns the contributing tokens of every window.
 */
function detectSplitPhone(norm) {
    const toks = unexplainedDigitTokens(norm);
    if (toks.length < 2 && !(toks.length === 1 && toks[0].digits.length >= 11 && toks[0].digits.length <= 13))
        return [];
    const hits = [];
    const flagged = new Set();
    // The recipient can read the fragments in either order ("rest 56789" sent
    // before "part 91234", or digits sent last-to-first), so the concatenation
    // is scanned in text order and in reverse token order.
    const scan = (order) => {
        // Map every concatenated digit position back to its token.
        const owner = [];
        let all = '';
        for (const idx of order) {
            for (let k = 0; k < toks[idx].digits.length; k++)
                owner.push(idx);
            all += toks[idx].digits;
        }
        for (let i = 0; i + 10 <= all.length; i++) {
            if (all[i] < '6')
                continue;
            const a = owner[i];
            const b = owner[i + 9];
            // One token is the PHONE rule's job unless it is an 11–13 digit run that
            // hides a mobile number behind extra digits.
            if (a === b && (toks[a].digits.length < 11 || toks[a].digits.length > 13))
                continue;
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            for (let k = lo; k <= hi; k++)
                flagged.add(k);
        }
    };
    const forward = toks.map((_, i) => i);
    scan(forward);
    if (toks.length > 1)
        scan(forward.slice().reverse());
    for (const k of [...flagged].sort((x, y) => x - y))
        hits.push(toOriginalHit(norm, PatternType.SPLIT_PHONE, toks[k].s, toks[k].e));
    return hits;
}
function runRegex(norm, re, pattern, out, accept) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(norm.text))) {
        if (m[0].length === 0) {
            re.lastIndex++;
            continue;
        }
        if (accept && !accept(m))
            continue;
        out.push(toOriginalHit(norm, pattern, m.index, m.index + m[0].length));
    }
}
/** Detect contact information in one text. */
function detectContact(original, options = {}) {
    const norm = normalizeForModeration(original);
    const hits = [];
    runRegex(norm, PHONE_RE, PatternType.INDIAN_PHONE, hits);
    runRegex(norm, INTL_PHONE_RE, PatternType.INTL_PHONE, hits, (m) => (m[0].match(/\d/g) || []).length >= 8);
    hits.push(...detectSplitPhone(norm));
    const emailHits = [];
    runRegex(norm, EMAIL_RE, PatternType.EMAIL, emailHits);
    for (const h of emailHits) {
        const rawSpan = original.slice(h.start, h.end);
        hits.push(rawSpan.includes('@') && !/\b(?:dot)\b/i.test(rawSpan) ? h : { ...h, pattern: PatternType.OBFUSCATED_EMAIL });
    }
    runRegex(norm, PROVIDER_RE, PatternType.EMAIL_PROVIDER, hits);
    runRegex(norm, UPI_RE, PatternType.UPI, hits);
    runRegex(norm, HANDLE_RE, PatternType.SOCIAL, hits, (m) => !emailHits.some((e) => e.start <= norm.from[m.index] && norm.to[m.index + m[0].length - 1] <= e.end) && !UPI_TAIL.test(m[0]));
    runRegex(norm, URL_SCHEME_RE, PatternType.URL, hits, (m) => !isAllowedUrlHost(hostOf(m[0])));
    runRegex(norm, IPV4_RE, PatternType.URL, hits);
    // a purely numeric host label with a bare ccTLD is a numbered list item
    // ("12.As the candles…", "3.In case of…"), not a domain; real IPs are IPV4_RE
    // "rahulvilla . in", "rahulvilla .in", "www rahulvilla com", "http rahulvilla in":
    // a space before the dot (or a www/http lead-in) never occurs in prose, so
    // any valid TLD counts; "label. tld" (space only after the dot) is a sentence
    // boundary unless the TLD is not an English word (com, net, org …) or a lead-in precedes it.
    runRegex(norm, SPACED_URL_RE, PatternType.URL, hits, (m) => isValidTld(m[2]) && /[a-z]/.test(m[1]) && !isAllowedUrlHost(m[1] + '.' + m[2]));
    runRegex(norm, SPACED_DOMAIN_RE, PatternType.URL, hits, (m) => isValidTld(m[3]) && /[a-z]/.test(m[1]) && !isAllowedUrlHost(m[1] + '.' + m[3]) && (/\s/.test(m[2].slice(0, 1)) || !isWordLikeTld(m[3]) || URL_LEAD_IN_RE.test(norm.text.slice(Math.max(0, m.index - 40), m.index))));
    runRegex(norm, DOMAIN_RE, PatternType.URL, hits, (m) => isValidTld(m[2]) && /[a-z]/.test(m[1]) && !isAllowedUrlHost(m[0]) && !emailHits.some((e) => e.start <= norm.from[m.index] && norm.to[m.index + m[0].length - 1] <= e.end));
    const socialHits = [];
    runRegex(norm, SOCIAL_RE, PatternType.SOCIAL, socialHits);
    for (const h of socialHits)
        hits.push(extendOverHandle(norm, h));
    runRegex(norm, OFF_PLATFORM_RE, PatternType.OFF_PLATFORM, hits);
    runRegex(norm, CONTACT_INTENT_RE, PatternType.CONTACT_INTENT, hits);
    if (options.address)
        hits.push(...detectAddress(norm, options.address));
    // Legacy kind names for the WhatsApp/Telegram/Signal words (logs and older tests).
    for (const h of hits) {
        if (h.pattern !== PatternType.SOCIAL)
            continue;
        const w = h.match;
        if (/whats|watsap|wa\.me/.test(w))
            h.pattern = PatternType.WHATSAPP;
        else if (/telegram|t\.me/.test(w))
            h.pattern = PatternType.TELEGRAM;
        else if (/^signal/.test(w))
            h.pattern = PatternType.SIGNAL;
    }
    hits.sort((a, b) => a.start - b.start || a.end - b.end);
    const boundary = options.candidateStart ?? 0;
    const candidateHits = hits.filter((h) => h.end > boundary);
    const kinds = [...new Set(candidateHits.map((h) => h.pattern))];
    const status = kinds.some((k) => exports.BLOCKING_PATTERNS.has(k)) ? chat_types_1.ModerationStatus.BLOCKED : kinds.length ? chat_types_1.ModerationStatus.FLAGGED : chat_types_1.ModerationStatus.CLEAN;
    return { hits, kinds, status, candidateHits };
}
// "insta: rahul_123", "snapchat rahul123" — the channel word and the handle
// that follows it are one disclosure; the handle is swallowed when it looks
// like one (digits, underscore or dot inside it) or is introduced by ":" / "@".
const HANDLE_AFTER_RE = /^(\s*[:@\-]\s*|\s+)([a-z0-9][a-z0-9_.]{2,29})(?![a-z0-9_])/;
function extendOverHandle(norm, h) {
    const e = norm.text.indexOf(h.match, Math.max(0, indexInNormalized(norm, h.start)));
    const after = norm.text.slice(e + h.match.length, e + h.match.length + 40);
    const m = after.match(HANDLE_AFTER_RE);
    if (!m)
        return h;
    const sep = m[1].trim();
    const handle = m[2];
    const handleLike = /[0-9_.]/.test(handle) || sep === ':' || sep === '@';
    if (!handleLike || NON_HANDLE_WORDS.has(handle))
        return h;
    const endNorm = e + h.match.length + m[0].length;
    const ext = toOriginalHit(norm, h.pattern, e, endNorm);
    return { ...h, end: ext.end, match: norm.text.slice(e, endNorm) };
}
const NON_HANDLE_WORDS = new Set(['me', 'us', 'you', 'number', 'no', 'group', 'call', 'msg', 'message', 'chat', 'video', 'link', 'the', 'and', 'for', 'this', 'that', 'here', 'there', 'now', 'later', 'today', 'tomorrow', 'please', 'pls', 'plz']);
function indexInNormalized(norm, originalOffset) {
    // from[] is non-decreasing; first normalised char starting at/after the offset
    let lo = 0;
    let hi = norm.from.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (norm.from[mid] < originalOffset)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}
const UPI_TAIL = /@(?:ybl|oksbi|okaxis|okhdfcbank|okicici|paytm|upi|apl|ibl|axl|ptyes|ptsbi|ptaxis|yapl|fam)$/;
function hostOf(url) {
    const m = url.match(/^(?:https?:\/\/)?(?:[^@/]*@)?([^/:?#]+)/i);
    return m ? m[1] : '';
}
// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------
function mergeSpans(hits) {
    const spans = hits
        .filter((h) => exports.BLOCKING_PATTERNS.has(h.pattern))
        .map((h) => [h.start, h.end])
        .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of spans) {
        const last = merged[merged.length - 1];
        if (last && s <= last[1])
            last[1] = Math.max(last[1], e);
        else
            merged.push([s, e]);
    }
    return merged;
}
function applyMask(original, hits) {
    const spans = mergeSpans(hits);
    if (!spans.length)
        return original;
    let out = '';
    let p = 0;
    for (const [s, e] of spans) {
        out += original.slice(p, s) + exports.MASK;
        p = e;
    }
    return out + original.slice(p);
}
/** Replace every blocked span of one text with `•••`. */
function maskContactInfo(original, options = {}) {
    if (!original)
        return original;
    return applyMask(original, detectContact(original, options).hits);
}
// A sentence boundary between two parts ("…peaceful environment." + "No guests")
// is usually not a split identifier: glued it would read "environment.no" (a
// .no domain) or turn "at all." + "No" into an obfuscated e-mail. The glued
// pass still glues it (so "rahulvilla." + "Com", "rahulvilla." + "in" and every
// non-word TLD are caught), and drops only a URL / e-mail hit that spans the
// boundary when its TLD is a two-letter ccTLD that doubles as an English word
// or abbreviation at a sentence start (in, no, it, is, at, …) AND nothing in
// front of the host reads as a lead-in to a web address ("see", "visit",
// "website", "www", …). The remaining exception — an English-word ccTLD as a
// capitalised sentence start with no lead-in — is the documented product
// exception: it is indistinguishable from ordinary prose and no reader would
// perceive a web address across a field boundary and a capital letter.
function sentenceBoundary(prev, next) {
    return /[.!?]\s*$/.test(prev) && /^\s*\p{Lu}/u.test(next);
}
function crossBoundaryException(joined, h) {
    if (h.pattern !== PatternType.URL && h.pattern !== PatternType.EMAIL && h.pattern !== PatternType.OBFUSCATED_EMAIL)
        return false;
    const lastLabel = (h.match.toLowerCase().replace(/[/?#].*$/, '').match(/\.([a-z]{2,24})$/) || [])[1];
    if (!lastLabel || !isWordLikeTld(lastLabel))
        return false;
    const before = normalizeForModeration(joined.slice(Math.max(0, h.start - 40), h.start)).text;
    return !URL_LEAD_IN_RE.test(before);
}
function detectJoined(parts, separator, options, candidateIndex) {
    const offsets = [];
    const boundaries = []; // glued sentence boundaries
    const glued = []; // every glued boundary
    let joined = '';
    parts.forEach((p, i) => {
        if (i) {
            const sep = typeof separator === 'function' ? separator(i) : separator;
            joined += sep;
            if (!sep) {
                glued.push(joined.length);
                if (sentenceBoundary(parts[i - 1], p))
                    boundaries.push(joined.length);
            }
        }
        offsets.push(joined.length);
        joined += p;
    });
    const candidateStart = candidateIndex !== undefined ? offsets[candidateIndex] : options.candidateStart;
    const res = detectContact(joined, { ...options, candidateStart });
    const spansBoundary = (h) => boundaries.some((b) => h.start < b && h.end > b);
    const spansGlue = (h) => glued.some((b) => h.start < b && h.end > b);
    // A bare "@" accepted as its own message must not turn every following word
    // into a handle ("@" + "thanks"): a handle assembled across a glued boundary
    // needs a digit, an underscore or a dot in it, like a real one.
    const looseHandleAcrossGlue = (h) => h.pattern === PatternType.SOCIAL && /^@[a-z]+$/.test(h.match) && spansGlue(h);
    const hits = res.hits.filter((h) => !(boundaries.length && spansBoundary(h) && crossBoundaryException(joined, h)) && !(glued.length && looseHandleAcrossGlue(h)));
    const boundary = candidateStart ?? 0;
    const candidateHits = hits.filter((h) => h.end > boundary);
    const kinds = [...new Set(candidateHits.map((h) => h.pattern))];
    const status = kinds.some((k) => exports.BLOCKING_PATTERNS.has(k)) ? chat_types_1.ModerationStatus.BLOCKED : kinds.length ? chat_types_1.ModerationStatus.FLAGGED : chat_types_1.ModerationStatus.CLEAN;
    const locate = (h) => {
        const out = [];
        for (let i = 0; i < parts.length; i++) {
            const ps = offsets[i];
            const pe = ps + parts[i].length;
            const s = Math.max(h.start, ps);
            const e = Math.min(h.end, pe);
            if (s < e)
                out.push({ ...h, part: i, start: s - ps, end: e - ps, match: parts[i].slice(s - ps, e - ps) });
        }
        return out;
    };
    return { hits: hits.flatMap(locate), kinds, status, candidateHits: candidateHits.flatMap(locate) };
}
function mergeResults(a, b) {
    const key = (h) => `${h.part}:${h.start}:${h.end}:${h.pattern}`;
    const seen = new Set(a.hits.map(key));
    const hits = [...a.hits, ...b.hits.filter((h) => !seen.has(key(h)))];
    const seenC = new Set(a.candidateHits.map(key));
    const candidateHits = [...a.candidateHits, ...b.candidateHits.filter((h) => !seenC.has(key(h)))];
    const kinds = [...new Set([...a.kinds, ...b.kinds])];
    const status = kinds.some((k) => exports.BLOCKING_PATTERNS.has(k)) ? chat_types_1.ModerationStatus.BLOCKED : kinds.length ? chat_types_1.ModerationStatus.FLAGGED : chat_types_1.ModerationStatus.CLEAN;
    return { hits, kinds, status, candidateHits };
}
/**
 * Detect across several texts as one resource: fragments split across parts
 * (title + description, message 1 + message 2) are found, and every hit is
 * reported with the index of the part it lands in. Parts are examined both
 * separated (so "98765" / "43210" chain as digit tokens) and glued together
 * without a separator (so "rahul" / "@gmail.com" or "rahulvilla" / ".in"
 * form one identifier).
 */
// Variants of one resource: every part separated (a line break), everything
// glued (an identifier spread over many parts), and each single boundary glued
// with the rest separated — gluing everything also glues the parts AROUND a
// two-part split ("rahul" + "@ybl" + "rest 56789" → "rahul@yblrest", an
// invalid handle), so the pairwise variants are what catch a split next to
// other text. The pairwise pass covers the newest PAIRWISE_BOUNDARIES boundaries.
const PAIRWISE_BOUNDARIES = 30;
function detectContactInParts(parts, options = {}, candidateIndex) {
    const separated = detectJoined(parts, PART_SEPARATOR, options, candidateIndex);
    if (parts.length < 2)
        return separated;
    let merged = mergeResults(separated, detectJoined(parts, '', options, candidateIndex));
    // Judging a candidate: only the boundaries that touch it can add a hit to it
    // (an identifier finished by the candidate across fillers is the all-glued
    // pass's job), so the live send path costs three detections, not thirty.
    // Masking a whole resource judges every recent boundary.
    const boundaries = [];
    if (candidateIndex !== undefined) {
        if (candidateIndex > 0)
            boundaries.push(candidateIndex);
        if (candidateIndex + 1 < parts.length)
            boundaries.push(candidateIndex + 1);
    }
    else {
        for (let b = Math.max(1, parts.length - PAIRWISE_BOUNDARIES); b < parts.length; b++)
            boundaries.push(b);
    }
    const relevant = parts.map((p) => isContextRelevant(p));
    for (const b of boundaries) {
        // two plain-prose parts cannot form an identifier when glued (the all-glued pass still covers spelled-out runs)
        if (!relevant[b - 1] && !relevant[b])
            continue;
        merged = mergeResults(merged, detectJoined(parts, (i) => (i === b ? '' : PART_SEPARATOR), options, candidateIndex));
    }
    return merged;
}
/** Mask every part of one resource, with fragments split across parts included. */
function maskContactInfoParts(parts, options = {}) {
    const { hits } = detectContactInParts(parts, options);
    return parts.map((p, i) => applyMask(p, hits.filter((h) => h.part === i)));
}
/**
 * Moderate a candidate message against the sender's accepted context: the
 * context is trusted (already delivered), so only hits touching the candidate
 * decide. Candidate hits are reported in candidate coordinates.
 */
function checkCandidate(context, candidate, options = {}) {
    const parts = [...context, candidate];
    const res = detectContactInParts(parts, options, parts.length - 1);
    const candidateHits = res.candidateHits.filter((h) => h.part === parts.length - 1).map(({ part: _part, ...h }) => h);
    return { hits: res.hits.map(({ part: _part, ...h }) => h), kinds: res.kinds, status: res.status, candidateHits };
}
/** Check text for contact information (legacy result shape). */
function checkText(text, options = {}) {
    const res = detectContact(text, options);
    const violations = res.hits.map((h) => ({ pattern: h.pattern, match: h.match, index: h.start, length: h.end - h.start }));
    const flaggedPatterns = [...new Set(res.hits.map((h) => h.pattern))];
    return {
        hasViolations: violations.length > 0,
        violations,
        confidence: calculateConfidence(violations),
        flaggedPatterns,
    };
}
/** Confidence: 1 for any blocking kind, 0.6 for intent only, 0 otherwise. */
function calculateConfidence(violations) {
    if (violations.length === 0)
        return 0;
    if (violations.some((v) => exports.BLOCKING_PATTERNS.has(v.pattern)))
        return 1;
    return 0.6;
}
function getModerationStatus(confidence) {
    if (confidence >= 0.9)
        return chat_types_1.ModerationStatus.BLOCKED;
    if (confidence >= 0.6)
        return chat_types_1.ModerationStatus.FLAGGED;
    return chat_types_1.ModerationStatus.CLEAN;
}
/** Kept for compatibility: the live rules are the compiled regexes above. */
exports.MODERATION_PATTERNS = {
    [PatternType.INDIAN_PHONE]: PHONE_RE,
    [PatternType.INTL_PHONE]: INTL_PHONE_RE,
    [PatternType.EMAIL]: EMAIL_RE,
    [PatternType.EMAIL_PROVIDER]: PROVIDER_RE,
    [PatternType.UPI]: UPI_RE,
    [PatternType.URL]: DOMAIN_RE,
    [PatternType.SOCIAL]: SOCIAL_RE,
    [PatternType.OFF_PLATFORM]: OFF_PLATFORM_RE,
    [PatternType.CONTACT_INTENT]: CONTACT_INTENT_RE,
};
const PROVIDER_TEST = new RegExp(PROVIDER_RE.source);
const SOCIAL_TEST = new RegExp(SOCIAL_RE.source);
const OFF_PLATFORM_TEST = new RegExp(OFF_PLATFORM_RE.source);
/** True when a text could be a piece of a split identifier (used for the outage policy). */
/**
 * Whether an accepted message must stay in the sender's moderation context
 * regardless of how many filler messages follow it: anything that can be a
 * piece of an identifier — a single digit (number words count after
 * normalisation), an @, a TLD-like token, a provider / social / payment word,
 * an obfuscated joiner or a handle-like token. Stored as moderation.fragment.
 */
function isContextRelevant(text) {
    const n = normalizeForModeration(text).text;
    return /\d/.test(n) || isFragmentBearing(text);
}
function isFragmentBearing(text) {
    const n = normalizeForModeration(text).text;
    return /\d.*\d/.test(n) || /@/.test(n) || /\.(?:[a-z]{2,24})(?![a-z])/.test(n) || PROVIDER_TEST.test(n) || /(?<![a-z])dot(?![a-z])|[([{]\s*at\s*[)\]}]/.test(n) || /[a-z0-9]_[a-z0-9]/.test(n) || SOCIAL_TEST.test(n) || OFF_PLATFORM_TEST.test(n);
}
// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
exports.NAME_MAX_LENGTH = 50;
// Letters of any script, spaces, dots, apostrophes and hyphens; must start with a letter.
const NAME_RE = /^\p{L}[\p{L}\p{M} .'\-]{0,49}$/u;
/**
 * A first/last name is acceptable when it is letters-only (any script) and
 * the contact detector finds nothing in it: "Rahul9876543210", "@rahul123",
 * "rahulvilla.in" and "WhatsApp Rahul" are all refused, "José" and
 * "Mary Jane" pass.
 */
function isAcceptableName(name) {
    if (typeof name !== 'string')
        return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > exports.NAME_MAX_LENGTH || !NAME_RE.test(trimmed))
        return false;
    return detectContact(trimmed).status === chat_types_1.ModerationStatus.CLEAN;
}
