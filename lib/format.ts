export function formatMoney(value:number|null|undefined,currency:string|null='INR'){
 return value==null?'Not listed':new Intl.NumberFormat('en-IN',{style:'currency',currency:currency||'INR',minimumFractionDigits:0,maximumFractionDigits:2}).format(value);
}
