# Attribution (Third-Party Credits)

This file lists content in **MyKotoba / Kotoba Cabinet** that was created by
other people, and the license terms that apply to it.

> Short version: the app code is original, the quiz questions and listening
> material were generated for this app, and the vocabulary lists come from
> the open-source projects below, used under the MIT License with credit.

---

## 1. Vocabulary lists (`attached_assets/data/vocab-n1.csv` … `vocab-n5.csv`)

- **Source:** [elzup/jlpt-word-list](https://github.com/elzup/jlpt-word-list)
- **Author:** elzup
- **License:** MIT License (full text below)
- **Upstream credit chain** (as documented by that project): the word data
  originates from [chyyran/jlpt-anki-decks](https://github.com/chyyran/jlpt-anki-decks),
  based on decks from [tanos.co.uk](http://www.tanos.co.uk/jlpt/); see also
  [jamsinclair/open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks)
  (MIT), which packages the same data as Anki decks.
- **What we changed:** removed the `guid` column where present; file names
  changed to `vocab-n1.csv` … `vocab-n5.csv`. Nothing else was modified.

```
MIT License

Copyright (c) elzup

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Font: Inter (SIL Open Font License 1.1)

- The app loads the **Inter** font from Google Fonts.
- **License:** SIL Open Font License 1.1 (free for commercial use).
- **Source:** <https://github.com/rsms/inter>

## 3. Open-source software libraries

- This app is built with open-source packages (React, Vite, Tailwind CSS,
  Radix UI, Firebase, and others — full list in `package.json` /
  `package-lock.json`). All are under permissive licenses (MIT, Apache-2.0,
  ISC, BSD). No changes were made to these libraries.

## 4. Sound effect: result-low feedback jingle (CC0, public domain)

- **File:** `attached_assets/feedback/result-low.mp3`
- **Source:** "Deep Low-Frequency Bass Drone with Slow Movement" by bassimat —
  https://freesound.org/people/bassimat/sounds/870179/
- **License:** Creative Commons 0 1.0 Universal (public domain). Free for
  commercial use and modification, no attribution required — credited here
  as a courtesy.
- **What we changed:** trimmed from 65s to a short jingle, converted WAV → MP3.

## 5. Quiz questions, listening scripts and audio (original, AI-generated)

- The questions in `attached_assets/data/jlpt-quiz-bank.csv`, the mock-exam
  data in `src/lib/*.json`, and the listening audio in
  `attached_assets/jlpt-listening/` were **written and generated for this
  app** (AI-assisted writing and text-to-speech, reviewed by the owner).
- They follow the **publicly documented JLPT test format** (question types,
  section layout, scoring bands) as published by the organisers, e.g.
  <https://www.jlpt.jp/e/>. Test formats and standard instructions are
  factual/conventional and are not copied from any official past paper.
- No official JLPT past questions, recordings, scripts or answer keys are
  reproduced anywhere in this app.

---

## Trademark note (not a copyright issue, but good manners)

- **JLPT** (Japanese-Language Proficiency Test) is a trademark of its
  organisers, the Japan Foundation and JEES. This app is an **unofficial**
  practice tool and is **not affiliated with or endorsed by** them.
- All quiz questions, listening scripts, and audio in this app are original
  practice material written/generated for this app. No official JLPT
  questions, recordings, or answer keys are reproduced.
