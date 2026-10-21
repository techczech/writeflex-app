---
widget_schema: 1
template: browser
template_version: 1
title: Process catalogue
source:
  path: ../structured-text/process-catalogue.md
  format: structured-markdown
  select:
    level: 3
mapping:
  title: heading
  detail: body
  group: parent-heading
views: [browser]
---
