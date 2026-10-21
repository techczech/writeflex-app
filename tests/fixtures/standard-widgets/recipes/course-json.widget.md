---
widget_schema: 1
template: data-explorer
template_version: 1
title: Courses from JSON
source:
  path: ../json/courses.json
  format: json
  select:
    pointer: /catalogue/courses
mapping:
  id: /id
  title: /title
  columns: [/title, /audience, /hours, /places, /provider/name]
  types:
    /hours: number
    /places: number
views: [table, scatter]
chart:
  x: /hours
  y: /places
---
