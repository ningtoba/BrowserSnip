/**
 * The character ranges the font-subset rig draws.
 *
 * One string per face id in `SCRIPT_FONTS`, plus the Latin range used by the
 * bundled faces. Each range holds characters that `detectScript` routes to the
 * face it is named after, so one probe PDF really exercises one embedding path.
 */

/** Printable ASCII, then the Latin-1 / Greek / Cyrillic text the app is asked for. */
export const LATIN = [
  ' ',
  ...'!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'.split(''),
  ...'ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜÑßàâäçéèêëîïôöùûüñ'.split(''),
  ...'ŒœŠšŸŽžƒˆ˜¢£¥§©®¶±µ·¿' .split(''),
  ...'–—‘’“”‹›•…€™'.split(''),
  ...'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω'.split(''),
  ...'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯабвгдежзийклмнопрстуфхцчшщэюяё'.split(''),
];

/** What the standard-14 faces can spell without throwing. */
export const WIN_ANSI = [
  ' ',
  ...'!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'.split(''),
  ...'ÀÂÄÇÉÈÊËÎÏÔÖÙÛÜÑßàâäçéèêëîïôöùûüñ'.split(''),
  ...'ŒœŠšŸŽžƒˆ˜¢£¥§©®¶±µ·¿' .split(''),
  ...'–—‘’“”‹›•…€™'.split(''),
];

export const SCRIPT_CHARS = {
  latin: LATIN,
  winAnsi: WIN_ANSI,
  arabic: [...'أبتثجحخدذرزسشصضطظعغفقكلمنهوىئءآؤ'].join(''),
  hebrew: [...'אבגדהוזחטיכלמנסעפצקרשתףךםןץ'].join(''),
  devanagari: [...'अआइईउऊएऐओऔकखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसह'].join(''),
  bengali: [...'অআইঈউঊএঐওঔকখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহ'].join(''),
  tamil: [...'அஆஇஈஉஊஎஏஐஓஔகஙசஜஞடணதநனபமயரலவழளறன'].join(''),
  telugu: [...'అఆఇఈఉఊఋఎఏఐఒఓఔకఖగఘఙచఛజఝఞటఠడఢణతథదధనపఫబభమయరలవశషసహళ'].join(''),
  kannada: [...'ಅಆಇಈಉಊಋಎಏಐಒಓಔಕಖಗಘಙಚಛಜಝಞಟಠಡಢಣತಥದಧನಪಫಬಭಮಯರಲವಶಷಸಹಳ'].join(''),
  malayalam: [...'അആഇഈഉഊഋഎഏഐഒഓഔകഖഗഘങചഛജഝഞടഠഡഢണതഥദധനപഫബഭമയരലവശഷസഹള'].join(''),
  thai: [...'กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ'].join(''),
  lao: [...'ກຂຄງຈຊຍດຕຖທນບປຜຝພຟມຢຣລວສຫອຮ'].join(''),
  khmer: [...'កខឃងគឆជឈញឋឌឍតណតថទធនបផពភមយរលវឝឞសហឡអ'].join(''),
  myanmar: [...'ကစဆဇဈဉတထဒဓနပဖဗဘမယရလဝသဟဠအဣဥဦဧ'].join(''),
  georgian: [...'აბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰ'].join(''),
  armenian: [...'ԱԲԳԴԵԶԷԸԹԺԻԼԽԾԿՀՁՂՃՄՅՆՇՈՉՊՋՌՍՎՏՐՑՒՓՔՕՖ'].join(''),
  ethiopic: [...'ሀለሐመሠረሰቀበተኀነአከወዐዘዙደገጠጰጸፀፈፐ'].join(''),
  // kana only: a kanji in this range would be routed to the SC face by
  // `detectScript`, and one PDF must exercise one embedding path.
  jp: [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ'].join(''),
  kr: [...'가가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조처카타파하한글문서페이지번호시간동경서적제목저자년도'].join(''),
  sc: [...'你好中国文字书页编号打印版本日期时间标题作者图书馆东西南北上下左右前后多少大小' ].join(''),
  tc: [...'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ'].join(''),
};
