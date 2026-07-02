The Ohio Revised code often includes language like:

```
(A) "General election" means the election held on the first Tuesday after the first Monday in each November.
```

After assembling the formatted Markdown files, our pipeline then builds a glossary (stored in JSON) of all terms defined in the Ohio Revised Code.

Some glossary terms only apply in a particular chapter or section, and the JSON glossary object lets this information be included so that display-time filtering can be applied properly.

Then, the display code on the front-end can recognize any glossary items in the rendered text, and let us navigate in some fashion to the glossary definition. 

This should be recursive, so terms in the footnote can be explained and dug into in similar fashion. Definitions include the original text and a link to the source of the definition (title, chapter, section, etc).

The goal of this is to be maximally educational and transparent for people new to the system who could otherwise be easily overwhelmed. We want this to feel friendly, welcoming, and demystifying -- to cut through some of the bureaucratic noise and nonsense that is unfortunately a frequent barrier to public participation.