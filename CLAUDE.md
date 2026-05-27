# Claude Code Instructions

## Deploy Rules
- ALWAYS run ./deploy.sh after every commit
- NEVER consider a change live until deploy.sh 
  confirms success
- At session start, verify server commit matches local:
  ssh root@139.180.215.150 'cd /root/ai-portfolio-strategist && git log --oneline -1'
  If different, run ./deploy.sh immediately before 
  any other work
- deploy.sh auto-verifies build timestamp — if it 
  fails, fix before continuing

## Key Principles
- Never read position state from local DB — always 
  fetch live from Bybit
- Discuss approach before implementing — no code 
  without confirmation
- Execution bugs we fix in code — strategy Claude 
  learns naturally
- Always consider API/infra cost impact

## Project Context
- See HANDOVER.md for full project state
- Server: root@139.180.215.150
- Deploy: cd /root/ai-portfolio-strategist && ./deploy.sh
