export const PROJECT_QUERY =
  'query($id:String!){project(id:$id){services{edges{node{id name}}} environments{edges{node{id name}}}}}';

export const DEPLOYMENTS_QUERY =
  'query($first:Int,$after:String,$p:String!,$e:String!,$s:String!){deployments(first:$first,after:$after,input:{projectId:$p,environmentId:$e,serviceId:$s}){edges{node{id status createdAt staticUrl meta}} pageInfo{hasNextPage endCursor}}}';

export const ENVIRONMENT_LOGS_QUERY =
  'query($e:String!,$f:String,$a:String,$b:String,$l:Int){environmentLogs(environmentId:$e,filter:$f,anchorDate:$a,beforeDate:$b,beforeLimit:$l,afterLimit:0){timestamp message severity attributes{key value} tags{deploymentId}}}';

export const DEPLOYMENT_LOGS_QUERY =
  'query($d:String!,$l:Int,$f:String,$s:DateTime,$e:DateTime){deploymentLogs(deploymentId:$d,limit:$l,filter:$f,startDate:$s,endDate:$e){timestamp message severity attributes{key value}}}';

export const BUILD_LOGS_QUERY =
  'query($d:String!,$l:Int,$f:String,$s:DateTime,$e:DateTime){buildLogs(deploymentId:$d,limit:$l,filter:$f,startDate:$s,endDate:$e){timestamp message severity attributes{key value}}}';

export const HTTP_LOGS_QUERY =
  'query($d:String!,$f:String,$a:String,$b:String,$l:Int){httpLogs(deploymentId:$d,filter:$f,anchorDate:$a,beforeDate:$b,beforeLimit:$l,afterLimit:0){timestamp method path httpStatus totalDuration requestId host}}';
