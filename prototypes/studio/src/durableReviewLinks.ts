import {browserStudioPath} from './studioUrl'

export type SavedCorrectionLink={extractionId:string;valueId:string;snapshotVersion:number;feedbackVersion:number}

/** A historical review link selects both immutable result and decision cuts. */
export function savedCorrectionHref(projectId:string,sourceDocumentId:string,correction:SavedCorrectionLink):string {
  const query=new URLSearchParams({extractionId:correction.extractionId,value:correction.valueId,
    snapshotVersion:String(correction.snapshotVersion),feedbackVersion:String(correction.feedbackVersion)})
  return browserStudioPath(`/projects/${projectId}/documents/${sourceDocumentId}?${query}`)
}

export function savedReviewCut(search:string):{snapshotVersion:number;feedbackVersion:number}|null {
  const query=new URLSearchParams(search),snapshot=query.get('snapshotVersion'),feedback=query.get('feedbackVersion')
  if(!snapshot||!feedback||!/^\d+$/.test(snapshot)||!/^\d+$/.test(feedback))return null
  const snapshotVersion=Number(snapshot),feedbackVersion=Number(feedback)
  return Number.isSafeInteger(snapshotVersion)&&snapshotVersion>0&&Number.isSafeInteger(feedbackVersion)
    ?{snapshotVersion,feedbackVersion}:null
}
