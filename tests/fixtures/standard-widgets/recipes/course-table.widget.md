---
widget_schema: 1
template: data-explorer
template_version: 1
title: Courses from a Markdown table
source:
  path: ../markdown-table/course-tables.md
  format: markdown-table
  select:
    heading: Courses
    index: 1
mapping:
  id: ID
  title: Title
  columns: [Title, Audience, Hours]
  types:
    Hours: number
views: [table]
---
