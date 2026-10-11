// Hindi (Devanagari) search text → the Latin words the gazetteer knows.
//
// A traveller who types "गोवा में विला" or "मनाली" used to get nothing: the
// gazetteer, the stay titles and normalizePlaceText (pinned byte-for-byte with
// the customer site) are Latin-script only. This maps the names people really
// type — destinations, stay types and the connecting words — to Latin before
// the text is read, so everything downstream (places, types, keywords, typo
// tolerance) works unchanged. Server-side and read-only: nothing is stored,
// no external transliteration service is called, and text with no Devanagari
// is returned untouched.
//
// Spelling varies a lot in Hindi (ी / ि, ू / ु, chandrabindu / anusvara,
// nukta, चंडीगढ़ / चण्डीगढ), so both the dictionary and the input are folded
// the same way before they are compared.

const DEVANAGARI = /[ऀ-ॿ]/;
const MAX_TOKENS = 12;

function fold(s) {
  return String(s)
    .normalize("NFC")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/ँ/g, "ं") // chandrabindu → anusvara
    .replace(/़/g, "") // nukta
    .replace(/[ी]/g, "ि") // ी → ि
    .replace(/[ू]/g, "ु") // ू → ु
    .replace(/ई/g, "इ") // ई → इ
    .replace(/ऊ/g, "उ") // ऊ → उ
    .replace(/[ॉॊ]/g, "ो") // ॉ → ो
    .replace(/ॅ/g, "े") // ॅ → े
    .replace(/ॐ/g, "ओम")
    .replace(/[।॥]/g, " ") // । ॥
    .replace(/्‍?/g, "्");
}

// Whole phrases first (longest wins), then single words.
const ENTRIES = [
  // regions and states
  ["गोवा", "goa"], ["गोआ", "goa"], ["उत्तर गोवा", "north goa"], ["दक्षिण गोवा", "south goa"],
  ["उत्तर प्रदेश", "uttar pradesh"], ["मध्य प्रदेश", "madhya pradesh"], ["हिमाचल प्रदेश", "himachal pradesh"], ["हिमाचल", "himachal"],
  ["अरुणाचल प्रदेश", "arunachal pradesh"], ["आंध्र प्रदेश", "andhra pradesh"], ["उत्तराखंड", "uttarakhand"], ["उत्तराखण्ड", "uttarakhand"],
  ["जम्मू कश्मीर", "jammu and kashmir"], ["कश्मीर", "kashmir"], ["लद्दाख", "ladakh"], ["तमिल नाडु", "tamil nadu"], ["तमिलनाडु", "tamil nadu"],
  ["पश्चिम बंगाल", "west bengal"], ["राजस्थान", "rajasthan"], ["गुजरात", "gujarat"], ["महाराष्ट्र", "maharashtra"], ["केरल", "kerala"],
  ["कर्नाटक", "karnataka"], ["तेलंगाना", "telangana"], ["पंजाब", "punjab"], ["हरियाणा", "haryana"], ["बिहार", "bihar"], ["झारखंड", "jharkhand"],
  ["ओडिशा", "odisha"], ["उड़ीसा", "odisha"], ["असम", "assam"], ["सिक्किम", "sikkim"], ["मेघालय", "meghalaya"], ["छत्तीसगढ़", "chhattisgarh"],
  ["अंडमान", "andaman"], ["कच्छ", "kutch"], ["स्पीति", "spiti"],
  // cities and destinations
  ["नई दिल्ली", "new delhi"], ["दिल्ली", "delhi"], ["पुरानी दिल्ली", "old delhi"], ["मुंबई", "mumbai"], ["मुम्बई", "mumbai"], ["बॉम्बे", "bombay"],
  ["कोलकाता", "kolkata"], ["चेन्नई", "chennai"], ["बेंगलुरु", "bengaluru"], ["बैंगलोर", "bangalore"], ["हैदराबाद", "hyderabad"], ["पुणे", "pune"],
  ["जयपुर", "jaipur"], ["उदयपुर", "udaipur"], ["जोधपुर", "jodhpur"], ["जैसलमेर", "jaisalmer"], ["पुष्कर", "pushkar"], ["माउंट आबू", "mount abu"],
  ["आगरा", "agra"], ["लखनऊ", "lucknow"], ["वाराणसी", "varanasi"], ["बनारस", "banaras"], ["अयोध्या", "ayodhya"], ["प्रयागराज", "prayagraj"],
  ["इलाहाबाद", "allahabad"], ["मथुरा", "mathura"], ["वृंदावन", "vrindavan"], ["उज्जैन", "ujjain"], ["भोपाल", "bhopal"], ["इंदौर", "indore"],
  ["अहमदाबाद", "ahmedabad"], ["सूरत", "surat"], ["द्वारका", "dwarka"], ["चंडीगढ़", "chandigarh"], ["चण्डीगढ़", "chandigarh"], ["अमृतसर", "amritsar"],
  ["शिमला", "shimla"], ["मनाली", "manali"], ["कसौली", "kasauli"], ["कसोल", "kasol"], ["धर्मशाला", "dharamshala"], ["धर्मकोट", "dharamkot"],
  ["मैकलोडगंज", "mcleod ganj"], ["मैक्लोडगंज", "mcleod ganj"], ["डलहौजी", "dalhousie"], ["मसूरी", "mussoorie"], ["नैनीताल", "nainital"],
  ["ऋषिकेश", "rishikesh"], ["हरिद्वार", "haridwar"], ["देहरादून", "dehradun"], ["जिम कॉर्बेट", "jim corbett"], ["लेह", "leh"], ["श्रीनगर", "srinagar"],
  ["गुलमर्ग", "gulmarg"], ["पहलगाम", "pahalgam"], ["गंगटोक", "gangtok"], ["दार्जिलिंग", "darjeeling"], ["शिलांग", "shillong"], ["गुवाहाटी", "guwahati"],
  ["ऊटी", "ooty"], ["कोडाइकनाल", "kodaikanal"], ["मुन्नार", "munnar"], ["कोच्चि", "kochi"], ["कोचीन", "cochin"], ["वायनाड", "wayanad"], ["अलेप्पी", "alleppey"],
  ["वर्कला", "varkala"], ["कोवलम", "kovalam"], ["गोकर्ण", "gokarna"], ["हम्पी", "hampi"], ["कूर्ग", "coorg"], ["मैसूर", "mysore"], ["पांडिचेरी", "pondicherry"],
  ["पुडुचेरी", "puducherry"], ["नासिक", "nashik"], ["शिरडी", "shirdi"], ["लोनावला", "lonavala"], ["महाबलेश्वर", "mahabaleshwar"], ["अलीबाग", "alibaug"],
  ["तिरुपति", "tirupati"], ["विशाखापत्तनम", "visakhapatnam"], ["पटना", "patna"], ["रांची", "ranchi"], ["भुवनेश्वर", "bhubaneswar"], ["पुरी", "puri"],
  // Goa places
  ["अंजुना", "anjuna"], ["बागा", "baga"], ["कैलंगुट", "calangute"], ["कलंगुट", "calangute"], ["कैंडोलिम", "candolim"], ["वागातोर", "vagator"], ["वागाटोर", "vagator"],
  ["पणजी", "panaji"], ["पंजिम", "panjim"], ["मडगांव", "margao"], ["मडगाव", "margao"], ["मापुसा", "mapusa"], ["म्हापसा", "mapusa"], ["अरपोरा", "arpora"],
  ["असगाव", "assagao"], ["मोरजिम", "morjim"], ["मांद्रेम", "mandrem"], ["अरंबोल", "arambol"], ["कोलवा", "colva"], ["पालोलेम", "palolem"], ["अगोंडा", "agonda"],
  ["कावेलोसिम", "cavelossim"], ["बेनौलिम", "benaulim"], ["वास्को", "vasco"], ["दाबोलिम", "dabolim"], ["ओल्ड गोवा", "old goa"], ["सिओलिम", "siolim"],
  ["दूधसागर", "dudhsagar"], ["हवाई अड्डा", "airport"], ["एयरपोर्ट", "airport"],
  // stay types
  ["विला", "villa"], ["विल्ला", "villa"], ["होटल", "hotel"], ["रिसॉर्ट", "resort"], ["होमस्टे", "homestay"], ["अपार्टमेंट", "apartment"], ["फ्लैट", "flat"],
  ["कॉटेज", "cottage"], ["कुटिया", "cottage"], ["टेंट", "tent"], ["कैंप", "camp"], ["कैंपिंग", "camping"], ["गेस्ट हाउस", "guest house"], ["फार्म हाउस", "farm house"],
  ["फार्महाउस", "farmhouse"], ["फार्म स्टे", "farm stay"], ["बंगला", "bungalow"], ["हाउस", "house"], ["घर", "house"], ["कमरा", "room"], ["रूम", "room"],
  ["हाउसबोट", "houseboat"], ["बीच", "beach"], ["समुद्र", "sea"], ["पूल", "pool"], ["स्टे", "stay"],
  // connecting words
  ["में", "in"], ["पास", "near"], ["नज़दीक", "near"], ["नजदीक", "near"], ["और", "and"],
  ["उत्तर", "north"], ["दक्षिण", "south"], ["पूर्व", "east"], ["पश्चिम", "west"],
];

// Words that carry no meaning of their own ("के पास" → near): dropped.
const DROPPED = new Set(["के", "का", "की", "है", "से", "को", "ने", "एक"].map(fold));

const PHRASES = new Map(); // folded Devanagari phrase → Latin
let MAX_WORDS = 1;
for (const [hi, en] of ENTRIES) {
  const k = fold(hi).trim().split(/\s+/).join(" ");
  PHRASES.set(k, en);
  MAX_WORDS = Math.max(MAX_WORDS, k.split(" ").length);
}

function hasDevanagari(text) {
  return typeof text === "string" && DEVANAGARI.test(text);
}

/**
 * "गोवा में विला" → "goa in villa". Text without Devanagari is returned
 * as is. Latin words in a mixed query ("goa में villa") are kept; Devanagari
 * words the dictionary does not know are dropped when something else
 * remains, and the original text is returned when nothing at all maps (the
 * search then says it found nothing, as it always did).
 */
function latinizeIndic(text) {
  if (!hasDevanagari(text)) return text;
  const tokens = fold(text).split(/[\s,;:/|()"'“”‘’\-–—.!?]+/).filter(Boolean).slice(0, MAX_TOKENS);
  const out = [];
  let mapped = 0;
  for (let i = 0; i < tokens.length; ) {
    let hit = null;
    for (let n = Math.min(MAX_WORDS, tokens.length - i); n >= 1; n--) {
      const en = PHRASES.get(tokens.slice(i, i + n).join(" "));
      if (en !== undefined) {
        hit = [n, en];
        break;
      }
    }
    if (hit) {
      out.push(hit[1]);
      mapped++;
      i += hit[0];
      continue;
    }
    const t = tokens[i++];
    if (!hasDevanagari(t)) out.push(t); // a Latin word typed alongside
    else if (DROPPED.has(t)) continue; // "के", "का"…
    // an unknown Devanagari word is dropped
  }
  return mapped && out.length ? out.join(" ") : text;
}

module.exports = { latinizeIndic, hasDevanagari, _fold: fold };
