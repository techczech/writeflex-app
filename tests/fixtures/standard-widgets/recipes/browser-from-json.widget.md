---
widget_schema: 1
template: browser
template_version: 1
title: Courses to browse (JSON array)
source:
  path: ../json/courses.json
  format: json
  select:
    pointer: /catalogue/courses
mapping:
  id: /id
  title: /title
  detail: /audience
views: [browser]
---
