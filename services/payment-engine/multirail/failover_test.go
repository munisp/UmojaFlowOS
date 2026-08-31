package multirail

import("context";"testing";"time")
type fakeRail struct{name string; submit Submission; submitErr error; query Submission; queryErr error; calls int}
func(f *fakeRail)Name()string{return f.name}
func(f *fakeRail)Submit(context.Context,Intent)(Submission,error){f.calls++;return f.submit,f.submitErr}
func(f *fakeRail)Query(context.Context,Intent)(Submission,error){return f.query,f.queryErr}
func TestSafeFallbackAfterConfirmedNonSubmission(t *testing.T){p:=&fakeRail{name:"yellow_card",submit:Submission{Status:Failed,RetryableWithoutBusinessEffect:true}};s:=&fakeRail{name:"bank",submit:Submission{Status:Submitted,ProviderRef:"b-1"}};r,e:=NewCoordinator().Execute(context.Background(),Intent{ID:"i1",IdempotencyKey:"k1",ExpiresAt:time.Now().Add(time.Minute)},p,s);if e!=nil||r.Rail!="bank"||s.calls!=1{t.Fatalf("r=%+v e=%v",r,e)}}
func TestUnknownOutcomeBlocksFallback(t *testing.T){p:=&fakeRail{name:"yellow_card",submit:Submission{Status:Unknown}};s:=&fakeRail{name:"bank",submit:Submission{Status:Submitted}};_,e:=NewCoordinator().Execute(context.Background(),Intent{ID:"i2",IdempotencyKey:"k2"},p,s);if e!=ErrUnknownOutcome||s.calls!=0{t.Fatalf("e=%v secondary_calls=%d",e,s.calls)}}
func TestPrimaryTransportErrorRequiresConfirmedQuery(t *testing.T){p:=&fakeRail{name:"yellow_card",submitErr:context.DeadlineExceeded,query:Submission{Status:Unknown}};s:=&fakeRail{name:"bank",submit:Submission{Status:Submitted}};_,e:=NewCoordinator().Execute(context.Background(),Intent{ID:"i3",IdempotencyKey:"k3"},p,s);if e!=ErrUnknownOutcome||s.calls!=0{t.Fatalf("e=%v secondary_calls=%d",e,s.calls)}}
func TestIdempotencyReturnsOriginalResult(t *testing.T){p:=&fakeRail{name:"yellow_card",submit:Submission{Status:Submitted,ProviderRef:"p1"}};s:=&fakeRail{name:"bank"};c:=NewCoordinator();in:=Intent{ID:"i4",IdempotencyKey:"k4"};a,_:=c.Execute(context.Background(),in,p,s);b,_:=c.Execute(context.Background(),in,p,s);if a!=b||p.calls!=1{t.Fatalf("a=%+v b=%+v calls=%d",a,b,p.calls)}}
