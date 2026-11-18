# Right-to-left text sitting (Persian and Arabic)

**For:** the owner, as a checklist for one sitting.
**Task:** T-A18 (prep). **Where:** Text panel and Monitor titles in JOY Media v1.1.1.
**Time:** about 30 to 40 minutes.

## Before you start

1. Make a **new test project** and call it `RTL test`. Do not open your real project for this sitting.
2. Do not import any files for this sitting.
3. Keep this page open next to the app. Tick each box when the result matches "Expect".

## What is already known

- **Escape in the Monitor text box SAVES the text.** It does not cancel. Clicking outside the box also saves.
- Direction is a setting on each title: **Auto**, **Left to right** or **Right to left**. The default is **Auto**. You find it in the Text panel, under Typography.
- In the earlier live pass, the Persian and Arabic title and caption tests were skipped (LTP-034, 035, 037, 038). This sitting is the first owner check of them.
- Earlier notes say the Monitor preview did not wrap long Persian lines and ignored letter spacing. A fix was pushed later, but nobody has checked it on screen yet. Look at line breaks closely.
- Captions are **not** part of this sitting.

## Sample lines to use

Copy each line exactly. Use the Text panel Content box for Part 1, and the Monitor box for Part 2.

- **S1 (Persian, 1-line title):** `جوی مدیا ۱.۱.۱ — سفری به کوهستان`
- **S2 (Persian, 3-line title):** type these three lines. Press Enter between them.
  - Line 1: `نمای شفق قطبی`
  - Line 2: `در شب‌های زمستان`
  - Line 3: `بر فراز دریاچه`
- **S3 (Persian words with English words and numbers):** `فیلم جدید Joy Media 2026`
- **S4 (Arabic with diacritics):** `مُحَرِّرُ الْفِيدْيُو الِاحْتِرَافِيُّ`
- **S5 (Persian digit string):** `۰۱۲۳۴۵۶۷۸۹ — ۱۴۰۵`

## Part 1: Text panel

1. [ ] Add a Title. Select it. Open the **Text** panel. Paste **S1** into the **Content** box. Click outside the box.
   - **Expect:** The title on the Monitor is one line. The Persian letters are joined. The text reads from right to left.

2. [ ] Change **Direction** to **Auto**, then **Left to right**, then **Right to left**. Look at the Monitor after each change.
   - **Expect:** Each choice changes the layout. With **Right to left**, S1 starts on the right side.

3. [ ] Change **Align** to **Start**, then **Center**, then **End**.
   - **Expect:** With Right to left, **Start** is on the right side and **End** is on the left side.

4. [ ] Replace the text with **S2** (three lines). Press Enter between the lines.
   - **Expect:** Three lines show on the Monitor, in the same order, top to bottom. No line is joined to another. No words are lost.

5. [ ] Change **Font** to **Vazirmatn**, then **Noto Naskh Arabic**, then **Noto Sans Arabic**. If the list has a font whose "scripts" text does not mention Persian, choose it too.
   - **Expect:** The Persian text shows in each font. There are no empty boxes and no question marks.

6. [ ] Replace the text with **S3** (the mixed line).
   - **Expect:** "Joy Media 2026" shows in the English order, from left to right. The Persian words keep their order.

7. [ ] Replace the text with **S4** (Arabic with diacritics).
   - **Expect:** The small marks above and below the letters sit on the right letters. No mark floats away from its letter.

8. [ ] Replace the text with **S5** (Persian digits).
   - **Expect:** The digits show as Persian digits, in the same order you typed them. They are not reversed.

9. [ ] Type one new word in the **Content** box. Click outside the box. Then press **Ctrl+Z** once.
   - **Expect:** The whole change goes back in one step. It does not go back letter by letter.

## Part 2: Monitor (double-click to edit)

10. [ ] Put **S2** back in the title. Double-click the title on the Monitor.
    - **Expect:** A text box appears on top of the title. The box is the same size as the title, and the text sits where the title was.

11. [ ] Press the **Left** and **Right** arrow keys several times. Then press **Home** and **End**.
    - **Expect:** The caret moves one letter at a time. It does not jump or skip a letter. Home and End go to the start and end of the line.

12. [ ] Press **Enter** to add a new line, type one Persian word, then press **Enter** again.
    - **Expect:** The new line goes below the old ones. Pressing Enter does not close the box.

13. [ ] Select a whole Persian word with the mouse. Then select a word with **Shift+Left** and **Shift+Right**.
    - **Expect:** The highlight covers the whole word. No letter is left out of the highlight.

14. [ ] Copy one Persian word with **Ctrl+C**. Paste it with **Ctrl+V** in the same box, at a new spot.
    - **Expect:** The pasted word matches the copied word, letter for letter and in the same order. No boxes or question marks appear.

15. [ ] Type a change in the box. Press **Escape**.
    - **Expect:** The box closes and **your new text stays**. This is the known behaviour: Escape saves.

16. [ ] Double-click the title again. Change one word. Then click on the empty grey area outside the title.
    - **Expect:** The box closes and the new text stays. It is saved once.

17. [ ] With the box closed, press **Ctrl+Z** once.
    - **Expect:** The change from step 16 goes back in one step. The title shows the text from before step 16.

## Part 3: Fonts and joined letters

18. [ ] Zoom in on the title on the Monitor until the letters are large. Look at **S2** and **S4**.
    - **Expect:** Persian and Arabic letters are joined the way they are in a printed book. No letter that should be joined stands alone. No letter is a box, a question mark or a wrong shape.

## Part 4: Export

19. [ ] Make the timeline hold only the title, and make it 3 seconds long. Use **S2** as the text. Export the project as MP4.
    - **Expect:** The export finishes with no error.

20. [ ] Play the exported MP4 in a video player. Pause it on a frame where the title is fully on screen. Look at the same frame on the Monitor.
    - **Expect:** The title looks the same in both: the same line breaks, the same letters, the same joins, the same direction and the same alignment. Small differences in size are fine. A different line break or missing letter is a problem.

## Part 5: Save and reopen

21. [ ] Save the test project (**Ctrl+S**). Close the project. Open it again from the project list.
    - **Expect:** Every title (S1 to S5) shows the same as before you closed it. The direction, alignment, line breaks, font and digits are all the same.

## Found a problem

If something does not match "Expect", write a note with these four things:

1. **Step number** (for example, "step 14").
2. **Exact text** you typed or pasted. Copy it from this page, so the letters are right.
3. **Screenshot** of the Monitor or the exported frame. On Windows, press **Win+Shift+S**.
4. **What you expected** and **what you saw**, in one or two short sentences.

Also write the sample name (S1 to S5) and the font and Direction setting you had.

## Sitting done

- [ ] All 21 steps are ticked, or each problem has a note.

Tester: ______________________ Date: ______________
