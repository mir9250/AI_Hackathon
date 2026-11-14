from datetime import datetime
from typing import Generic, TypeVar, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

T = TypeVar("T")


class DataResponse(BaseModel, Generic[T]):
    data: T


class ProfileInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    display_name: str = Field(min_length=1, max_length=80, strict=True)


class HouseInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80, strict=True)
    address: str = Field(min_length=1, max_length=500, strict=True)


class Profile(ProfileInput):
    user_id: UUID
    created_at: datetime
    updated_at: datetime


class House(HouseInput):
    house_id: UUID
    user_id: UUID
    created_at: datetime
    updated_at: datetime


class PhotoUploadResult(BaseModel):
    photo_id: UUID
    upload_status: str
    already_uploaded: bool


class PhotoRecord(BaseModel):
    deleting: bool = False
    photo_id: UUID
    house_id: UUID
    stage: str
    location: str
    original_path: str
    preview_path: str | None = None
    mime_type: str
    size_bytes: int
    upload_id: UUID
    paired_entry_photo_id: UUID | None = None
    created_at: datetime
    signed_url: str
    signed_url_expires_at: datetime
    analysis_status: str
    analysis: dict | None = None


class DamageFinding(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    type: str = Field(min_length=1, max_length=200)
    status: str = Field(min_length=1, max_length=500)
    description: str = Field(min_length=1, max_length=2000)
    recommendation: str = Field(min_length=1, max_length=2000)


class EntryAnalysisResult(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    overall_result: Literal['suspected', 'needs_review', 'none']
    damages: list[DamageFinding] = Field(max_length=30)

    @model_validator(mode='after')
    def consistent_findings(self):
        if self.overall_result == 'none' and self.damages:
            raise ValueError('none must have no findings')
        if self.overall_result == 'suspected' and not self.damages:
            raise ValueError('suspected must have findings')
        return self


class AnalysisRecord(BaseModel):
    photo_id: UUID
    status: Literal['pending', 'analyzing', 'completed', 'failed']
    overall_result: Literal['suspected', 'needs_review', 'none'] | None = None
    damages: list[DamageFinding] = Field(default_factory=list)
    model_name: str | None = None
    error_code: str | None = None
    started_at: datetime | None = None
    updated_at: datetime
    active_request_id: UUID | None = None

    @model_validator(mode='after')
    def validate_completed(self):
        if self.status == 'completed':
            EntryAnalysisResult(overall_result=self.overall_result, damages=self.damages)
        return self


class ComparisonResult(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    overall_result: Literal['change_suspected', 'needs_review', 'no_visible_change']
    changes: list[DamageFinding] = Field(max_length=30)

    @model_validator(mode='after')
    def consistent_changes(self):
        if self.overall_result == 'no_visible_change' and self.changes:
            raise ValueError('no_visible_change must have no findings')
        if self.overall_result == 'change_suspected' and not self.changes:
            raise ValueError('change_suspected must have findings')
        return self


class ComparisonRecord(BaseModel):
    exit_photo_id: UUID
    entry_photo_id: UUID
    status: Literal['pending', 'analyzing', 'completed', 'failed']
    overall_result: Literal['change_suspected', 'needs_review', 'no_visible_change'] | None = None
    changes: list[DamageFinding] = Field(default_factory=list)
    model_name: str | None = None
    error_code: str | None = None
    started_at: datetime | None = None
    updated_at: datetime
    active_request_id: UUID | None = None

    @model_validator(mode='after')
    def validate_completed(self):
        if self.status == 'completed':
            ComparisonResult(overall_result=self.overall_result, changes=self.changes)
        return self


class MoveOutPhotoRecord(PhotoRecord):
    paired_entry_photo_id: UUID
    entry_photo: PhotoRecord
    entry_signed_url: str
    entry_signed_url_expires_at: datetime
    comparison: ComparisonRecord | None = None
    comparison_status: str


class ContractCreateInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_type: Literal['pdf', 'images']
    upload_id: UUID


class ContractCompleteInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    all_pages_confirmed: bool = Field(strict=True)


class ContractRecord(BaseModel):
    contract_id: UUID
    house_id: UUID
    source_type: Literal['pdf', 'images']
    original_path: str | None = None
    page_count: int | None = None
    upload_id: UUID
    upload_status: Literal['draft', 'ready', 'deleting']
    created_at: datetime
    house: House
    uploaded_page_count: int
    analysis_status: str
    analysis: dict | None = None


class ContractPageRecord(BaseModel):
    page_id: UUID
    contract_id: UUID
    page_number: int
    original_path: str
    mime_type: str
    size_bytes: int
    signed_url: str
    original_signed_url: str
    signed_url_expires_at: datetime


class ContractDetail(ContractRecord):
    signed_url: str | None = None
    signed_url_expires_at: datetime | None = None
    pages: list[ContractPageRecord]


class ContractFileResult(BaseModel):
    contract_id: UUID
    page_id: UUID | None = None
    page_number: int | None = None
    page_count: int | None = None
    upload_status: Literal['draft', 'ready', 'deleting']
    stored: bool
    already_uploaded: bool


class ContractAnalyzeInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    consent: bool = Field(strict=True)


class ContractSummary(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    deposit: int | None = Field(ge=0)
    monthly_rent: int | None = Field(ge=0)
    maintenance_fee: int | None = Field(ge=0)
    contract_period: str | None
    special_clauses_summary: str | None


class ContractFinding(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    category: str = Field(min_length=1, max_length=200)
    priority: Literal['high','medium','low']
    title: str = Field(min_length=1, max_length=300)
    page_number: int = Field(ge=1, le=20)
    clause_excerpt: str = Field(min_length=1, max_length=3000)
    reason: str = Field(min_length=1, max_length=3000)
    recommended_action: str = Field(min_length=1, max_length=3000)
    evidence_type: Literal['explicit_clause','ambiguous_clause']


class ContractChecklistItem(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    title: str = Field(min_length=1, max_length=300)
    reason: str = Field(min_length=1, max_length=3000)
    action: str = Field(min_length=1, max_length=3000)


class ContractAnalysisResult(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    document_quality: Literal['readable','partially_readable','unreadable']
    summary: ContractSummary
    findings: list[ContractFinding] = Field(max_length=40)
    checklist: list[ContractChecklistItem] = Field(max_length=40)
    warnings: list[str] = Field(max_length=80)


class ContractAnalysisRecord(BaseModel):
    contract_id: UUID
    status: Literal['pending','analyzing','completed','failed']
    document_quality: Literal['readable','partially_readable','unreadable'] | None = None
    summary: ContractSummary | None = None
    findings: list[ContractFinding] = Field(default_factory=list)
    checklist: list[ContractChecklistItem] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    model_name: str | None = None
    error_code: str | None = None
    consent_at: datetime | None = None
    started_at: datetime | None = None
    updated_at: datetime
    active_request_id: UUID | None = None

    @model_validator(mode='after')
    def valid_completion(self):
        if self.status == 'completed':
            if self.document_quality not in {'readable','partially_readable'} or self.consent_at is None:
                raise ValueError('Completed contract requires readable content and consent')
            ContractAnalysisResult(document_quality=self.document_quality,summary=self.summary,
                findings=self.findings,checklist=self.checklist,warnings=self.warnings)
        return self
