export interface OpenRouterModel { id:string; name?:string; context_length?:number; pricing?:{prompt?:string;completion?:string}; }

/** Fetches the current OpenRouter catalog instead of keeping a stale local list. */
export async function fetchModels():Promise<OpenRouterModel[]> {
  const response=await fetch('https://openrouter.ai/api/v1/models',{headers:{'Accept':'application/json'}});
  if(!response.ok) throw new Error(`OpenRouter models failed (${response.status})`);
  const body=await response.json() as {data?:OpenRouterModel[]};
  return (body.data??[]).sort((a,b)=>a.id.localeCompare(b.id));
}
