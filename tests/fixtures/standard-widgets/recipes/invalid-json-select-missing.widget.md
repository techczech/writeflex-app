---
widget_schema: 1
template: data-explorer
template_version: 1
title: JSON source with no selector
source:
  path: ../json/courses.json
  format: json
mapping:
  id: /id
  title: /title
views: [table]
---
