#!/usr/bin/env python3
"""
Build the static example-sentence files used by the quiz "Example sentence" box.

  attached_assets/ssw/<Sector>/*.pdf   ->   public/examples/<sector>.json

Run it again whenever PDFs are added or changed, commit the JSON, deploy.
The app never reads PDFs and never touches D1 for this feature: it only fetches
one small static JSON file (served by Cloudflare's static-asset layer).

Setup (dev machine only):   pip install pymupdf fugashi unidic-lite
Usage:                      python scripts/build-example-sentences.py

What goes in (strict on purpose - "no example" is better than a wrong example):
  * Question-style PDFs (【1】 ... then 1. 2. 3. 4. choices): ONLY the question
    sentence. The four choices are never used, because wrong choices are false statements.
  * Textbook PDFs with furigana: complete sentences (ending in 。 ？ ！) with the original
    furigana, written as  漢字(よみ).
  * Every sentence is tokenised once here; the app only accepts a match that starts and
    ends on a word boundary, so "気温" is not found inside "空気温度" (= 空気 + 温度).
File format (version 1):
  {"version":1,"sector":"manufacture","sources":["Calipers",...],
   "sentences":[[ "text with 漢字(よみ)", sourceIndex, page, "hex word-boundary mask" ], ...]}
Boundary mask: bit i (MSB-first inside each hex digit) is 1 when a word starts/ends at
character i of the text WITHOUT furigana (i = 0..length).
"""
import glob, json, os, re, sys, unicodedata
import pymupdf
from fugashi import Tagger

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'attached_assets', 'ssw')
OUT = os.path.join(ROOT, 'public', 'examples')
tagger = Tagger()

KANA = 'ぁ-ゖァ-ヺーｰ'
FURI = re.compile(r'\(([' + KANA + r']{1,40})\)')
ALLOWED = re.compile(r'^[\u3005\u3006\u30f6\u4e00-\u9fff\u3040-\u30ff\uff66-\uff9f0-9A-Za-z、。，．・：；？！「」『』（）〈〉《》【】〜～ー＋－×÷=<>%％℃°/.,:;?!\-+()\[\]]+$')
MIN_LEN, MIN_LEN_PROSE, MAX_LEN = 8, 12, 90   # textbook lines shorter than 12 are often fragments


def strip_furigana(text: str) -> str:
    return FURI.sub('', text)


def is_kanji(c: str) -> bool:
    return '\u4e00' <= c <= '\u9fff' or c in '々〆ヶ'


# ── textbook (furigana) rows: small text above a kanji run is its reading ────────
def page_rows(pg):
    rd = pg.get_text('rawdict')
    big, ruby = [], []
    for b in rd['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                chars = [(c['c'], c['bbox']) for c in s['chars']]
                if not chars:
                    continue
                (big if s['size'] > 9 else ruby).append((s['bbox'], chars if s['size'] > 9 else ''.join(c for c, _ in chars)))
    rows = []
    for bb, ch in sorted(big, key=lambda t: (round(t[0][1] / 4), t[0][0])):
        for r in rows:
            if abs(r['y0'] - bb[1]) < 4 and abs(r['y1'] - bb[3]) < 5:
                r['chars'] += ch
                break
        else:
            rows.append({'y0': bb[1], 'y1': bb[3], 'chars': list(ch)})
    for r in rows:
        r['chars'].sort(key=lambda c: c[1][0])
        r['ruby'] = []
    for bb, t in ruby:
        best = None
        for r in rows:
            d = r['y0'] - bb[3]
            if -6 <= d <= 12 and (best is None or abs(d) < abs(best[0])):
                best = (d, r)
        if best:
            best[1]['ruby'].append((bb, t))
    return rows


def row_text(r):
    ch = r['chars']
    n = len(ch)
    assign = [[] for _ in range(n)]
    rubs = sorted(r['ruby'], key=lambda x: x[0][0])
    for k, (bb, t) in enumerate(rubs):
        idx = [i for i, (c, b) in enumerate(ch) if is_kanji(c) and bb[0] - 1 <= (b[0] + b[2]) / 2 <= bb[2] + 1]
        if not idx:
            cand = [(abs((b[0] + b[2]) / 2 - (bb[0] + bb[2]) / 2), i) for i, (c, b) in enumerate(ch) if is_kanji(c)]
            if not cand:
                continue
            idx = [min(cand)[1]]
        for i in idx:
            assign[i].append(k)
    out, i = '', 0
    while i < n:
        c = ch[i][0]
        if is_kanji(c) and assign[i]:
            j, ks = i, []
            while j < n and is_kanji(ch[j][0]) and assign[j]:
                for k in assign[j]:
                    if k not in ks:
                        ks.append(k)
                j += 1
            out += ''.join(x[0] for x in ch[i:j]) + '(' + ''.join(rubs[k][1] for k in ks) + ')'
            i = j
        else:
            out += c
            i += 1
    return out


def prose_pages(doc):
    """Yield (page, text) - rows of a page joined in reading order."""
    for pn, pg in enumerate(doc, 1):
        rows = sorted(page_rows(pg), key=lambda r: r['y0'])
        yield pn, ''.join(row_text(r) for r in rows if r['chars'])


# ── question PDFs ──────────────────────────────────────────────────────────────
QSTART = re.compile(r'^\s*【(\d+)】\s*(.*)$')
CHOICE1 = re.compile(r'^\s*1\s*[.．]\s')


def question_stems(doc):
    """Yield (page, number, stem). The stem is everything between 【n】 and choice '1.'."""
    cur = None
    for pn, pg in enumerate(doc, 1):
        for line in pg.get_text().split('\n'):
            m = QSTART.match(line)
            if m:
                if cur:
                    yield cur
                cur = [pn, int(m.group(1)), m.group(2), False]
            elif cur and not cur[3]:
                if CHOICE1.match(line):
                    cur[3] = True
                else:
                    cur[2] += line
    if cur:
        yield cur


# ── cleanup / validation ─────────────────────────────────────────────────────────
def tidy(text: str, furigana: bool) -> str:
    text = unicodedata.normalize('NFKC', text)
    text = re.sub(r'\s+', '', text).replace('\u00ad', '')    # PDFs insert stray spaces next to Japanese text
    # NFKC turns full-width ？！（） into ASCII; sentence splitting needs them back.
    text = text.replace('?', '？').replace('!', '！')
    if not furigana:                                           # question PDFs have no furigana: "(" is a real bracket
        text = text.replace('(', '（').replace(')', '）')
    return text


def split_sentences(text: str):
    # keep the closing punctuation with its sentence; 」 right after 。 stays attached
    parts = re.findall(r'[^。？！]+[。？！]+[」』）]?', text)
    return [p for p in parts]


def valid(sentence: str, prose: bool = False) -> bool:
    plain = strip_furigana(sentence)
    if not ((MIN_LEN_PROSE if prose else MIN_LEN) <= len(plain) <= MAX_LEN):
        return False
    if '(' in sentence.replace('(', '(', 1) and re.search(r'\((?![' + KANA + r']{1,40}\))', sentence):
        # a "(" that is not a furigana reading, e.g. "(1)" or a table fragment
        if re.search(r'\((?![' + KANA + r']{1,40}\))', sentence):
            return False
    if not ALLOWED.match(plain) or re.search(r'[\x00-\x1f\x7f]', sentence):
        return False
    if re.search(r'\.{2,}|…|‥', plain) or re.match(r'^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮー、。・)」』）:：]', plain):
        return False                                                 # table leaders / a line that starts in the middle of a word
    if not re.search(r'[\u3040-\u30ff]', plain):                    # needs some kana to be a sentence
        return False
    if not re.search(r'[。？！][」』）]?$', plain):
        return False
    if re.match(r'^[①-⑳\d]+[.、)）]?$', plain[:3]):                 # list numbers / table rows
        return False
    if re.search(r'(.)\1{3,}', plain):                               # extraction glitches (ああああ, 発発発発)
        return False
    # A number followed by a kana/kanji that is not a unit means a page number, list number or heading
    # was glued to the sentence by the PDF layout ("…594いなさく…", "特徴1厚くやわらか…") -> drop it.
    units = '年月日時分秒個本枚倍割位号回番人度歳階台種類匹頭羽つ株代等名点冊軒層段粒束面期条例件世か所ヶ箇週間以上下前後目周'
    if prose and re.search(r'\d(?![\d.,%％℃°/\-〜~a-zA-Zａ-ｚＡ-Ｚァ-ヶー' + units + r'])[\u3040-\u309f\u4e00-\u9fff]', plain):
        return False
    if len(re.findall(r'\d', plain)) > 8:
        return False
    return True


def boundary_mask(plain: str):
    ends, pos = [0], 0
    for w in tagger(plain):
        pos += len(w.surface)
        ends.append(pos)
    if pos != len(plain):                                            # tokenizer skipped characters
        return None
    bits = ['0'] * (len(plain) + 1)
    for e in ends:
        bits[e] = '1'
    bits += ['0'] * (-len(bits) % 4)
    return ''.join('%x' % int(''.join(bits[i:i + 4]), 2) for i in range(0, len(bits), 4))


def build_sector(folder: str):
    sector = os.path.basename(folder).lower()
    sources, sentences, seen = [], [], set()
    stats = {'pdfs': 0, 'kept': 0, 'dropped': 0, 'dup': 0}
    for path in sorted(glob.glob(os.path.join(folder, '*.pdf'))):
        name = os.path.splitext(os.path.basename(path))[0]
        doc = pymupdf.open(path)
        sample = '\n'.join(doc[i].get_text() for i in range(min(3, doc.page_count)))
        items = []                                                    # (page, raw text)
        if len(re.findall(r'【\d+】', sample)) >= 2:
            for pn, _num, stem, _ in question_stems(doc):
                items += [(pn, s) for s in split_sentences(tidy(stem, False))]
        else:
            # whole document as one stream so sentences that run over a page break stay whole
            stream, marks = '', []
            for pn, text in prose_pages(doc):
                marks.append((len(stream), pn))
                stream += tidy(text, True)
            for m in re.finditer(r'[^。？！]+[。？！]+[」』）]?', stream):
                pn = max((p for off, p in marks if off <= m.start()), default=1)
                # a bullet glyph (control character) starts a new item: keep only the text after it
                items.append((pn, re.split(r'[\x00-\x1f]', m.group(0))[-1]))
        stats['pdfs'] += 1
        prose = not (len(re.findall(r'【\d+】', sample)) >= 2)
        src_index = None
        for pn, raw in items:
            plain = strip_furigana(raw)
            if not valid(raw, prose) or plain in seen:
                stats['dup' if plain in seen else 'dropped'] += 1
                continue
            mask = boundary_mask(plain)
            if mask is None:
                stats['dropped'] += 1
                continue
            seen.add(plain)
            if src_index is None:
                sources.append(name)
                src_index = len(sources) - 1
            sentences.append([raw, src_index, pn, mask])
            stats['kept'] += 1
    return sector, {'version': 1, 'sector': sector, 'sources': sources, 'sentences': sentences}, stats


def main():
    os.makedirs(OUT, exist_ok=True)
    folders = [f for f in sorted(glob.glob(os.path.join(SRC, '*'))) if os.path.isdir(f)]
    if not folders:
        sys.exit(f'No sector folders found in {SRC}')
    for folder in folders:
        sector, data, stats = build_sector(folder)
        path = os.path.join(OUT, f'{sector}.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
        print(f"{sector}: {stats['pdfs']} PDFs, kept {stats['kept']}, dropped {stats['dropped']}, duplicates {stats['dup']}, "
              f"{os.path.getsize(path) / 1024:.0f} KB -> {os.path.relpath(path, ROOT)}")


if __name__ == '__main__':
    main()
