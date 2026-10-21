---
widget_schema: 1
template: data-explorer
template_version: 1
title: Course catalogue
source:
  path: ../csv/courses.csv
  format: csv
mapping:
  id: course_id
  title: title
  detail: description
  columns: [title, audience, duration_hours]
  search: [title, description]
  filters: [audience]
  types:
    duration_hours: number
views: [table, cards, bar]
chart:
  category: audience
  metric: count
x_author_note: kept by every recipe writer
---

The author's introduction stays below the recipe and is never rewritten by a build.
