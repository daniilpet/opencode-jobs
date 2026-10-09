const object = { type: 'object', additionalProperties: true };
export const Jobs = {
  id: 'opencode-jobs',
  events: {},
  methods: Object.fromEntries(['tick', 'create', 'attach', 'fail', 'list', 'cancel', 'preflight'].map((name) => [name, { input: object, output: object }])),
};
