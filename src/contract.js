const object = { type: 'object', additionalProperties: true };
export const Jobs = {
  id: 'opencode-jobs',
  events: {},
  methods: Object.fromEntries(['tick', 'create', 'attach', 'fail', 'list', 'cancel'].map((name) => [name, { input: object, output: object }])),
};
