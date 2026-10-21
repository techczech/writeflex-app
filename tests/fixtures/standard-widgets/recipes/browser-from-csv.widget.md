---
widget_schema: 1
template: browser
template_version: 1
title: Courses to browse (CSV)
source:
  path: ../csv/courses.csv
  format: csv
mapping:
  id: course_id
  title: title
  detail: description
  group: audience
views: [browser, list]
---
