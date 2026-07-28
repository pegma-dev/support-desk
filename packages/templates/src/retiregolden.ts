import { defineTemplate } from "./index.js";

/** Host-branded content; the generic renderer contains no product policy. */
export const retireGoldenCustomerReply = defineTemplate({
  id: "retiregolden.customer-reply",
  version: 1,
  variables: ["ticket_number", "message_body", "ticket_url"],
  httpsUrlVariables: ["ticket_url"],
  plainText:
    "RetireGolden Support replied to ticket #{{ticket_number}}.\n\n{{message_body}}\n\nView and reply: {{ticket_url}}",
  html: '<p>RetireGolden Support replied to ticket #{{ticket_number}}.</p><p>{{message_body}}</p><p><a href="{{ticket_url}}">View and reply</a></p>',
});
