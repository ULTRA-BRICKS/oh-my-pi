<system-reminder>
{{#if toolName}}
This turn MUST be a call to the `{{toolName}}` tool. Call `{{toolName}}` now; do not reply with text only.
{{else}}
This turn MUST be a tool call. Call one of the available tools now; do not reply with text only.
{{/if}}
</system-reminder>
