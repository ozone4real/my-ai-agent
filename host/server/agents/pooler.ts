import { Agent, AgentOptions } from "./index"
import { setTimeout } from "node:timers/promises"

class AgentPooler {
  private pool: Agent[]
  private agentOptions: AgentOptions
  private min: number
  private max: number
  private static pool_poll_interval = 5000 // 5s
  public poolSize: number


  constructor(agentOptions: AgentOptions, min: number = 1, max: number = 5) {
    this.pool = Array.from({ length: min }).map(() => new Agent(agentOptions))
    this.poolSize = min

    this.agentOptions = agentOptions
    this.min = min
    this.max = max
  }
  
  async lease(): Promise<Agent> {
    while(true) {
      let agent = this.pool.pop()
      if(agent) return agent
      if(this.canSpawnMore) {
        this.spawnAgent()
        continue
      }
      await this.wait()
    }
  }

  wait(): Promise<void> {
    return setTimeout(AgentPooler.pool_poll_interval)
  }

  return(agent: Agent){
    agent.cleanup()
    this.pool.push(agent)
  }

  private spawnAgent(): void {
    const agent = new Agent(this.agentOptions)
    this.pool.push(agent)
    this.poolSize++
  }

  private get canSpawnMore() {
    return this.poolSize < this.max
  }
}