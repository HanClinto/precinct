The Ohio Revised code often includes language like:

```
(A) "General election" means the election held on the first Tuesday after the first Monday in each November.
```

After assembling the formatted Markdown files, our pipeline then builds a glossary (stored in JSON) of all terms defined in the Ohio Revised Code.

Then, the display code on the front-end can recognize any glossary items in the rendered text, and upon hovering -- present a small and friendly "?" icon that can be clicked on to bring up a footnote definition that explains the term. This is recursive, so terms in the footnote can be explained and dug into in similar fashion. Definitions include the original text and a link to the source of the definition (title, chapter, section, etc).

The goal of this is to be maximally educational and transparent for people new to the system who could otherwise be easily overwhelmed. We want this to feel friendly, welcoming, and demystifying -- to cut through some of the beurocratic noise and nonsense that is unfortunately a frequent barrier to public participation.