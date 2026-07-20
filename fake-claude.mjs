// Stand-in for the `claude` CLI: emit one can_use_tool permission request on
// stdout, then echo whatever control_response the engine writes back (to stderr,
// which the engine surfaces as a 'stderr' event the test can observe).
const req = {
  type: 'control_request',
  request_id: 'req-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    display_name: 'Bash',
    input: { command: 'echo hi' },
    tool_use_id: 'tu-1',
    permission_suggestions: [],
  },
}
process.stdout.write(JSON.stringify(req) + '\n')
process.stdin.on('data', (d) => process.stderr.write('RESP ' + d.toString()))
setTimeout(() => process.exit(0), 2000)
