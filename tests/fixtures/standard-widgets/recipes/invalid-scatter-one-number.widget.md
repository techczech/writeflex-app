---
widget_schema: 1
template: data-explorer
template_version: 1
title: A scatter plot with only one number field
source:
  path: ../json/courses.json
  format: json
  select:
    pointer: /catalogue/courses
mapping:
  id: /id
  title: /title
  columns: [/title, /audience, /hours]
  types:
    /hours: number
views: [table, scatter]
chart:
  x: /hours
  y: /audience
---
