import type { LanguageModelV3, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Plugin, Provider, Model } from "@opencode/plugin"
import type { ToolPlane } from "./linux"

function isInput(value:unknown):value is Record<string,unknown>{return typeof value==="object" && value!==null && !Array.isArray(value)}

export const providerID = "r0-23-in-process"
export const modelID = "synthetic-tool-wiring"
export const steps = [
  {tool:"write",input:{path:"probe.txt",content:"alpha\n"}},
  {tool:"read",input:{path:"probe.txt"}},
  {tool:"edit",input:{path:"probe.txt",oldText:"alpha",newText:"beta"}},
  {tool:"shell",input:{command:"test $(cat probe.txt) = beta && bun --version"}},
  {tool:"read",input:{path:"probe.txt"}},
] as const

/** No network, provider credentials or inference. Requires the real tool sequence before returning. */
export function probePlugin(plane: ToolPlane, record: (tool:string,result:string)=>Promise<void>) {
  let completed=0, modelCalls=0
  const usage={inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}}
  const model:LanguageModelV3={
    specificationVersion:"v3",provider:providerID,modelId:modelID,supportedUrls:{},
    async doGenerate(){throw new Error("synthetic probe requires streaming")},
    async doStream(options){
      if(++modelCalls>8) throw new Error("synthetic probe exceeded fixed model-call bound")
      options.abortSignal?.throwIfAborted()
      const step=steps[completed]
      const parts:LanguageModelV3StreamPart[]=[{type:"stream-start",warnings:[]}]
      if(step) parts.push({type:"tool-call",toolCallId:`probe-${completed}`,toolName:step.tool,input:JSON.stringify(step.input)})
      else parts.push({type:"text-start",id:"answer"},{type:"text-delta",id:"answer",delta:"R0_23_TOOL_WIRING_COMPLETE"},{type:"text-end",id:"answer"})
      parts.push({type:"finish",usage,finishReason:{unified:step?"tool-calls":"stop",raw:step?"tool_calls":"stop"}})
      return {stream:new ReadableStream<LanguageModelV3StreamPart>({start(controller){for(const part of parts)controller.enqueue(part);controller.close()}})}
    },
  }
  return Plugin.define({id:"r0-23.synthetic-linux-wiring",async setup(ctx){
    await ctx.provider.transform(editor=>editor.add({info:{id:Provider.ID.make(providerID),name:"R0-23 synthetic only",activation:"enabled",package:"aisdk:r0-23-in-process"},models:[{...Model.Info.default(Provider.ID.make(providerID),Model.ID.make(modelID)),package:"aisdk:r0-23-in-process",limit:{context:32768,output:1024}}]}))
    await ctx.aisdk.hook("sdk",event=>{event.sdk={languageModel:()=>model}},{providerID:Provider.ID.make(providerID)})
    await ctx.tool.transform(tools=>{
      for(const tool of tools.list()) tools.remove(tool.id)
      for(const name of ["read","write","edit","shell"] as const) {
        const properties=name==="shell"?{command:{type:"string" as const}}:name==="write"?{path:{type:"string" as const},content:{type:"string" as const}}:name==="edit"?{path:{type:"string" as const},oldText:{type:"string" as const},newText:{type:"string" as const}}:{path:{type:"string" as const}}
        tools.add({name,description:"Fixed disposable Linux probe tool: "+name,options:{codemode:false},input:{type:"object",properties,required:Object.keys(properties),additionalProperties:false},async execute(input,context){
          const expected=steps[completed]
          if(!isInput(input) || !expected || name!==expected.tool || Object.keys(input).length!==Object.keys(expected.input).length || Object.entries(expected.input).some(([key,value])=>input[key]!==value)) throw new Error("unexpected synthetic tool call")
          const result=await plane.execute(name,input,context.signal)
          if(name==="read" && result!==(completed===1?"alpha\n":"beta\n")) throw new Error("tool read did not observe prior write/edit")
          await record(name,result);completed++
          return {content:result}
        }})
      }
    })
  }})
}
