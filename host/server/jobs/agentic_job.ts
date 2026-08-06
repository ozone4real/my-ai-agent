import { Job } from "bullmq";
import ApplicationJob, { JobQueueName } from "./application_job";
import { TaskModel } from "../models/task";
import { Agent } from "../agents";
import { STATUSES, TaskRunModel } from "../models/task_run";

export default class AgenticJob extends ApplicationJob {
  public queueName = JobQueueName.AGENTS
  public attempts = 10

  async process(job: Job) {
    const task = await TaskModel.findById(job.data.taskId)
    if(!task) return
    const taskRun = await TaskRunModel.create({ task: task._id })
    const agent = new Agent()
    let status;
    try {
      agent.run(task.prompt)
      status = "success"
    } catch(error) {
      status = "failed"
    } finally {
      await taskRun.updateOne({ status, transcript: agent.serializedConversationHistory, endedAt: Date.now() })
    }
  }
}